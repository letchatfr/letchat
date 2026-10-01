const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const escapeLike = value => value.replace(/[\\%_]/g, c => `\\${c}`);
export async function installMessageTools({ app, pool, io, auth, requireAdult, requireRules, rateLimitAction, hasPremiumAccess, roomCatalog, validateMessageContent }) {
  await pool.query(`ALTER TABLE letchat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    ALTER TABLE letchat_private_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS letchat_notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      private_messages BOOLEAN NOT NULL DEFAULT TRUE, friendships BOOLEAN NOT NULL DEFAULT TRUE,
      preview BOOLEAN NOT NULL DEFAULT TRUE, quiet_until TIMESTAMPTZ
    );`);
  const base = [auth, requireAdult, requireRules];
  async function preferences(id) {
    const row = (await pool.query('SELECT private_messages,friendships,preview,quiet_until FROM letchat_notification_preferences WHERE user_id=$1', [id])).rows[0];
    return row || { private_messages: true, friendships: true, preview: true, quiet_until: null };
  }
  app.get('/api/notification-preferences', ...base, wrap(async (req, res) => res.json(await preferences(req.user.id))));
  app.patch('/api/notification-preferences', ...base, rateLimitAction('notification-preferences', 20, 60000), wrap(async (req, res) => {
    const b = req.body || {};
    if (Object.keys(b).some(k => !['private_messages', 'friendships', 'preview', 'quietHours'].includes(k)) ||
      ['private_messages', 'friendships', 'preview'].some(k => typeof b[k] !== 'boolean') || ![0, 1, 8, 24].includes(b.quietHours)) fail('Préférences incorrectes');
    await pool.query(`INSERT INTO letchat_notification_preferences(user_id,private_messages,friendships,preview,quiet_until)
      VALUES($1,$2,$3,$4,CASE WHEN $5=0 THEN NULL ELSE NOW()+($5::text||' hours')::interval END)
      ON CONFLICT(user_id) DO UPDATE SET private_messages=$2,friendships=$3,preview=$4,quiet_until=EXCLUDED.quiet_until`,
      [req.user.id, b.private_messages, b.friendships, b.preview, b.quietHours]);
    res.json(await preferences(req.user.id));
  }));
  app.get('/api/message-search', ...base, rateLimitAction('message-search', 40, 60000), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim(), kind = String(req.query.kind || 'public'), scope = String(req.query.scope || 'cafe');
    const before = String(req.query.before || '9223372036854775807');
    if (q.length < 2 || q.length > 100 || !/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n) fail('Saisissez entre 2 et 100 caractères');
    let rows;
    if (kind === 'public') {
      if (!Object.hasOwn(roomCatalog, scope) || scope === 'messages') fail('Salon incorrect');
      if (roomCatalog[scope].premium && !await hasPremiumAccess(req.user.id)) fail('Ce salon est réservé aux membres Premium.', 403);
      rows = (await pool.query(`SELECT m.id,m.author,m.body,m.created_at,m.edited_at,m.expires_at FROM letchat_messages m
        WHERE m.room=$1 AND m.expires_at>NOW() AND m.id<$4 AND m.body ILIKE '%'||$3||'%'
        AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=m.user_id) OR (b.blocked_id=$2 AND b.blocker_id=m.user_id))
        ORDER BY m.id DESC LIMIT 31`, [scope, req.user.id, escapeLike(q), before])).rows;
    } else if (kind === 'private') {
      rows = (await pool.query(`SELECT m.id,m.sender_name AS author,m.body,m.created_at,m.edited_at,m.expires_at
        FROM letchat_private_messages m WHERE m.expires_at>NOW() AND m.id<$4 AND m.body ILIKE '%'||$3||'%'
        AND ((m.sender_id=$2 AND m.recipient_id=$1) OR (m.sender_id=$1 AND m.recipient_id=$2))
        AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=$2) OR (b.blocked_id=$1 AND b.blocker_id=$2))
        AND NOT EXISTS(SELECT 1 FROM letchat_conversation_preferences p WHERE p.user_id=$2 AND p.other_id=$1 AND m.created_at<=p.hidden_before)
        ORDER BY m.id DESC LIMIT 31`, [scope, req.user.id, escapeLike(q), before])).rows;
    } else fail('Type de conversation incorrect');
    res.json({ items: rows.slice(0, 30), next: rows.length > 30 ? rows[29].id : null, retentionHours: 48 });
  }));
  app.patch(['/api/messages/public/:id', '/api/messages/private/:id'], ...base, rateLimitAction('message-edit', 20, 60000), wrap(async (req, res) => {
    const kind = req.path.startsWith('/api/messages/private/') ? 'private' : 'public';
    const { id } = req.params, body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!['public', 'private'].includes(kind) || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) fail('Message incorrect');
    if (!body || body.length > 4000) fail('Le message doit contenir entre 1 et 4 000 caractères.');
    const contentError = validateMessageContent(body); if (contentError) fail(contentError);
    const table = kind === 'public' ? 'letchat_messages' : 'letchat_private_messages', owner = kind === 'public' ? 'user_id' : 'sender_id';
    const db = await pool.connect(); let message;
    try {
      await db.query('BEGIN');
      const old = (await db.query(`SELECT * FROM ${table} WHERE id=$1 AND ${owner}=$2 AND expires_at>NOW() FOR UPDATE`, [id, req.user.id])).rows[0];
      if (!old) fail('Message introuvable ou modification interdite.', 404);
      if (kind === 'public') {
        if (roomCatalog[old.room]?.premium && !await hasPremiumAccess(req.user.id)) fail('Accès Premium requis.', 403);
        const state = (await db.query('SELECT read_only FROM letchat_room_settings WHERE room=$1', [old.room])).rows[0];
        if (state?.read_only) fail('Ce salon est actuellement en lecture seule.', 403);
      } else {
        if ((await db.query(`SELECT 1 FROM letchat_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [req.user.id, old.recipient_id])).rowCount) fail('Cette conversation est bloquée.', 403);
      }
      // Optimistic concurrency: never silently overwrite an edit made in another tab.
      if (req.body.previousBody !== old.body) fail('Ce message a changé. Actualisez la conversation avant de le modifier.', 409);
      message = (await db.query(`UPDATE ${table} SET body=$2,edited_at=NOW() WHERE id=$1 RETURNING id,body,edited_at,expires_at`, [id, body])).rows[0];
      await db.query('COMMIT');
      // Invalidation contains no text. Recipients re-read through authenticated endpoints.
      const audience = kind === 'public' ? io.to(old.room) : io.to(`user:${req.user.id}`).to(`user:${old.recipient_id}`);
      audience.emit('message-updated', { id, private: kind === 'private', room: old.room });
      res.json(message);
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }));
  return { preferences };
}
