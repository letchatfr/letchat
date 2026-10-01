import { randomUUID } from 'node:crypto';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const themes = new Set(['general', 'musique', 'cinema', 'gaming', 'regions', 'rencontres']);
const clean = (value, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(`Texte attendu : ${min} à ${max} caractères.`);
  return value.trim();
};
const id = value => { if (!/^[a-f0-9-]{36}$/.test(value || '')) fail('Communauté incorrecte'); return value; };
const messageId = value => { if (!/^[1-9]\d{0,17}$/.test(String(value))) fail('Message incorrect'); return String(value); };
export async function installSpaces({ app, pool, io, auth, requireAdult, requireRules, adminAuth, isAdminUser, rateLimitAction, validateMessageContent }) {
  await pool.query(`CREATE TABLE IF NOT EXISTS letchat_spaces (
    id TEXT PRIMARY KEY, owner_id TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
    name TEXT NOT NULL, description TEXT NOT NULL, theme TEXT NOT NULL, rules TEXT NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1, archived BOOLEAN NOT NULL DEFAULT FALSE,
    paused BOOLEAN NOT NULL DEFAULT FALSE, moderation_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS letchat_space_members (
    space_id TEXT NOT NULL REFERENCES letchat_spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','moderator')),
    banned BOOLEAN NOT NULL DEFAULT FALSE, accepted_version INTEGER NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(space_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS letchat_space_messages (
    id BIGSERIAL PRIMARY KEY, space_id TEXT NOT NULL REFERENCES letchat_spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE, body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '48 hours'
  );
  CREATE INDEX IF NOT EXISTS idx_space_messages ON letchat_space_messages(space_id,id);
  CREATE INDEX IF NOT EXISTS idx_space_expiry ON letchat_space_messages(expires_at);
  CREATE INDEX IF NOT EXISTS idx_space_members_user ON letchat_space_members(user_id,space_id);`);
  const base = [auth, requireAdult, requireRules], write = [...base, rateLimitAction('space-write', 40, 60000)];
  async function transaction(fn) {
    const db = await pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  const projection = `s.id,s.name,s.description,s.theme,s.rules,s.rules_version,s.archived,s.paused,s.created_at,
    COALESCE(p.display_name,'Compte supprimé') AS owner_name,s.owner_id,
    COALESCE(m.banned,FALSE) AS banned,(m.user_id IS NOT NULL AND NOT m.banned) AS joined,
    m.role,m.accepted_version,
    (SELECT COUNT(*)::int FROM letchat_space_members n WHERE n.space_id=s.id AND NOT n.banned) AS member_count`;
  async function space(spaceId, uid, db = pool, lock = false) {
    if (lock) await db.query('SELECT id FROM letchat_spaces WHERE id=$1 FOR UPDATE', [spaceId]);
    const row = (await db.query(`SELECT ${projection} FROM letchat_spaces s LEFT JOIN profiles p ON p.user_id=s.owner_id
      LEFT JOIN letchat_space_members m ON m.space_id=s.id AND m.user_id=$2 WHERE s.id=$1`, [spaceId, uid])).rows[0];
    if (!row) fail('Communauté introuvable.', 404);
    return row;
  }
  async function available(s, uid, db = pool) {
    if (s.banned) fail('Vous ne pouvez plus accéder à cette communauté.', 403);
    if (s.owner_id && (await db.query(`SELECT 1 FROM letchat_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [uid, s.owner_id])).rowCount)
      fail('Cette communauté est indisponible.', 403);
  }
  async function member(s, uid, db = pool, writing = false) {
    await available(s, uid, db);
    if (!s.joined) fail('Rejoignez cette communauté pour lire les échanges.', 403);
    if (writing && (s.archived || s.paused || !s.owner_id)) fail('Les échanges sont en pause dans cette communauté.', 403);
    if (writing && s.accepted_version !== s.rules_version) fail('Les règles ont changé. Relisez-les avant de participer.', 409);
  }
  function manager(s, req) { return s.owner_id === req.user.id || (s.joined && s.role === 'moderator' && !s.banned) || isAdminUser(req.user); }
  async function emit(spaceId) {
    const rows = (await pool.query('SELECT user_id FROM letchat_space_members WHERE space_id=$1 AND NOT banned', [spaceId])).rows;
    for (const row of rows) io.to(`user:${row.user_id}`).emit('space-update', { id: spaceId });
  }
  async function log(db, req, action, s, target = null, reason = '') {
    await db.query(`INSERT INTO letchat_moderation_log(admin_id,admin_name,action,target_user_id,details)
      VALUES($1,$2,$3,$4,$5)`, [req.user.id, req.user.name, action, target, `Communauté ${s.name} (${s.id}) — ${reason}`]);
  }
  app.get('/api/spaces', ...base, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80).replace(/[\\%_]/g, c => `\\${c}`);
    const theme = String(req.query.theme || ''), page = Math.max(1, Math.min(100, parseInt(req.query.page, 10) || 1));
    if (theme && !themes.has(theme)) fail('Thème incorrect');
    const rows = (await pool.query(`SELECT ${projection} FROM letchat_spaces s LEFT JOIN profiles p ON p.user_id=s.owner_id
      LEFT JOIN letchat_space_members m ON m.space_id=s.id AND m.user_id=$1
      WHERE NOT COALESCE(m.banned,FALSE) AND (NOT s.archived OR m.user_id IS NOT NULL) AND (s.owner_id IS NOT NULL OR m.user_id IS NOT NULL)
      AND ($2='' OR s.name ILIKE '%'||$2||'%' OR s.description ILIKE '%'||$2||'%') AND ($3='' OR s.theme=$3)
      AND (NOT $4 OR m.user_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=s.owner_id) OR (b.blocked_id=$1 AND b.blocker_id=s.owner_id))
      ORDER BY (m.user_id IS NOT NULL) DESC,s.created_at DESC,s.id LIMIT 25 OFFSET $5`, [req.user.id, q, theme, req.query.mine === 'true', (page - 1) * 24])).rows;
    res.json({ items: rows.slice(0, 24), next: rows.length > 24 ? page + 1 : null });
  }));
  app.post('/api/spaces', ...write, rateLimitAction('space-create', 3, 86400000), wrap(async (req, res) => {
    if (req.user.guest) fail('Conservez votre compte avant de créer une communauté.', 403);
    const b = req.body || {}, name = clean(b.name, 3, 60), description = clean(b.description, 10, 300), rules = clean(b.rules, 10, 1500);
    if (!themes.has(b.theme)) fail('Choisissez un thème');
    const spaceId = randomUUID();
    await transaction(async db => {
      await db.query('SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE', [req.user.id]);
      if ((await db.query('SELECT 1 FROM letchat_spaces WHERE owner_id=$1 AND NOT archived', [req.user.id])).rowCount >= 5) fail('Vous pouvez gérer cinq communautés actives.');
      await db.query('INSERT INTO letchat_spaces(id,owner_id,name,description,theme,rules) VALUES($1,$2,$3,$4,$5,$6)', [spaceId, req.user.id, name, description, b.theme, rules]);
      await db.query('INSERT INTO letchat_space_members(space_id,user_id,accepted_version) VALUES($1,$2,1)', [spaceId, req.user.id]);
    });
    res.status(201).json(await space(spaceId, req.user.id));
  }));
  app.get('/api/spaces/:id', ...base, wrap(async (req, res) => {
    const s = await space(id(req.params.id), req.user.id); await available(s, req.user.id); res.json(s);
  }));
  app.post('/api/spaces/:id/join', ...write, wrap(async (req, res) => {
    const spaceId = id(req.params.id);
    await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true); await available(s, req.user.id, db);
      if (s.archived || s.paused || !s.owner_id) fail('Cette communauté est en pause.', 403);
      if (req.body?.rulesVersion !== s.rules_version) fail('Relisez la version actuelle des règles.', 409);
      await db.query(`INSERT INTO letchat_space_members(space_id,user_id,accepted_version) VALUES($1,$2,$3)
        ON CONFLICT(space_id,user_id) DO UPDATE SET accepted_version=$3`, [spaceId, req.user.id, s.rules_version]);
    });
    await emit(spaceId); res.json(await space(spaceId, req.user.id));
  }));
  app.delete('/api/spaces/:id/membership', ...write, wrap(async (req, res) => {
    const spaceId = id(req.params.id);
    await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true);
      if (s.owner_id === req.user.id) fail('Transférez la responsabilité ou archivez votre communauté avant de la quitter.', 409);
      await db.query('DELETE FROM letchat_space_members WHERE space_id=$1 AND user_id=$2 AND NOT banned', [spaceId, req.user.id]);
    });
    await emit(spaceId); res.json({ ok: true });
  }));
  app.patch('/api/spaces/:id', ...write, wrap(async (req, res) => {
    const spaceId = id(req.params.id), b = req.body || {};
    const name = clean(b.name, 3, 60), description = clean(b.description, 10, 300), rules = clean(b.rules, 10, 1500);
    if (!themes.has(b.theme) || typeof b.archived !== 'boolean') fail('Paramètres incorrects');
    await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true);
      if (s.owner_id !== req.user.id) fail('Seul le responsable peut modifier cette communauté.', 403);
      if (b.rulesVersion !== s.rules_version) fail('Les règles ont changé. Rechargez avant de modifier.', 409);
      await db.query(`UPDATE letchat_spaces SET name=$2,description=$3,theme=$4,rules=$5,archived=$6,
        rules_version=rules_version+CASE WHEN rules<>$5 THEN 1 ELSE 0 END WHERE id=$1`, [spaceId, name, description, b.theme, rules, b.archived]);
      await log(db, req, 'space_updated', s);
    });
    await emit(spaceId); res.json(await space(spaceId, req.user.id));
  }));
  app.get('/api/spaces/:id/members', ...base, wrap(async (req, res) => {
    const s = await space(id(req.params.id), req.user.id); await member(s, req.user.id);
    if (!manager(s, req)) fail('Accès réservé aux responsables.', 403);
    const page = Math.max(1, Math.min(100, parseInt(req.query.page, 10) || 1));
    const rows = (await pool.query(`SELECT m.user_id,m.role,m.banned,p.display_name FROM letchat_space_members m JOIN profiles p ON p.user_id=m.user_id
      WHERE m.space_id=$1 ORDER BY m.banned,p.display_name,m.user_id LIMIT 31 OFFSET $2`, [s.id, (page - 1) * 30])).rows;
    res.json({ items: rows.slice(0, 30), next: rows.length > 30 ? page + 1 : null });
  }));
  app.patch('/api/spaces/:id/members/:userId', ...write, wrap(async (req, res) => {
    const spaceId = id(req.params.id), target = req.params.userId, action = req.body?.action, reason = clean(req.body?.reason, 3, 300);
    if (!['ban', 'unban', 'moderator', 'member', 'transfer'].includes(action)) fail('Action incorrecte');
    await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true);
      if (!manager(s, req) || target === s.owner_id || target === req.user.id) fail('Action interdite.', 403);
      const m = (await db.query('SELECT * FROM letchat_space_members WHERE space_id=$1 AND user_id=$2', [spaceId, target])).rows[0];
      if (!m) fail('Membre introuvable.', 404);
      if (s.owner_id !== req.user.id && (!['ban', 'unban'].includes(action) || m.role === 'moderator')) fail('Action réservée au responsable.', 403);
      if (action === 'transfer') {
        if (m.banned || (await db.query('SELECT 1 FROM letchat_local_accounts WHERE user_id=$1 AND is_guest', [target])).rowCount) fail('Choisissez un membre permanent actif.');
        await db.query('UPDATE letchat_spaces SET owner_id=$2 WHERE id=$1', [spaceId, target]);
      } else if (['ban', 'unban'].includes(action)) await db.query('UPDATE letchat_space_members SET banned=$3 WHERE space_id=$1 AND user_id=$2', [spaceId, target, action === 'ban']);
      else await db.query('UPDATE letchat_space_members SET role=$3 WHERE space_id=$1 AND user_id=$2', [spaceId, target, action]);
      await log(db, req, `space_${action}`, s, target, reason);
    });
    io.to(`user:${target}`).emit('space-update', { id: spaceId }); await emit(spaceId); res.json({ ok: true });
  }));
  app.get('/api/spaces/:id/messages', ...base, wrap(async (req, res) => {
    const s = await space(id(req.params.id), req.user.id); await member(s, req.user.id);
    const before = req.query.before ? messageId(req.query.before) : '9223372036854775807';
    const rows = (await pool.query(`SELECT m.id,m.user_id,p.display_name AS author,m.body,m.created_at,m.expires_at FROM letchat_space_messages m
      JOIN profiles p ON p.user_id=m.user_id WHERE m.space_id=$1 AND m.expires_at>NOW() AND m.id<$3
      AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=m.user_id) OR (b.blocked_id=$2 AND b.blocker_id=m.user_id))
      ORDER BY m.id DESC LIMIT 51`, [s.id, req.user.id, before])).rows;
    res.json({ items: rows.slice(0, 50).reverse(), next: rows.length > 50 ? rows[49].id : null });
  }));
  app.post('/api/spaces/:id/messages', ...write, rateLimitAction('space-message', 8, 10000), wrap(async (req, res) => {
    const spaceId = id(req.params.id), body = clean(req.body?.body, 1, 4000), problem = validateMessageContent(body); if (problem) fail(problem);
    const message = await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true); await member(s, req.user.id, db, true);
      if ((await db.query(`SELECT 1 FROM letchat_space_messages WHERE space_id=$1 AND user_id=$2 AND body=$3 AND created_at>NOW()-INTERVAL '2 minutes'`, [spaceId, req.user.id, body])).rowCount) fail('Vous avez déjà envoyé ce message récemment.', 429);
      return (await db.query('INSERT INTO letchat_space_messages(space_id,user_id,body) VALUES($1,$2,$3) RETURNING id,body,created_at,expires_at', [spaceId, req.user.id, body])).rows[0];
    });
    await emit(spaceId); res.status(201).json(message);
  }));
  app.delete('/api/spaces/:id/messages/:message', ...write, wrap(async (req, res) => {
    const spaceId = id(req.params.id), mid = messageId(req.params.message);
    await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true); await member(s, req.user.id, db);
      const m = (await db.query('SELECT user_id FROM letchat_space_messages WHERE id=$1 AND space_id=$2', [mid, spaceId])).rows[0];
      if (!m) fail('Message introuvable.', 404);
      if (m.user_id !== req.user.id && !manager(s, req)) fail('Suppression interdite.', 403);
      if (m.user_id !== req.user.id) await log(db, req, 'space_message_deleted', s, m.user_id, clean(req.body?.reason, 3, 300));
      await db.query('DELETE FROM letchat_space_messages WHERE id=$1', [mid]);
    });
    await emit(spaceId); res.json({ ok: true });
  }));
  app.get('/api/admin/spaces', auth, adminAuth, wrap(async (req, res) => {
    const page = Math.max(1, Math.min(100, parseInt(req.query.page, 10) || 1));
    const rows = (await pool.query(`SELECT id,name,theme,paused,archived,moderation_reason,created_at FROM letchat_spaces ORDER BY created_at DESC,id LIMIT 31 OFFSET $1`, [(page - 1) * 30])).rows;
    res.json({ items: rows.slice(0, 30), next: rows.length > 30 ? page + 1 : null });
  }));
  app.patch('/api/admin/spaces/:id', auth, adminAuth, rateLimitAction('space-admin', 30, 60000), wrap(async (req, res) => {
    const spaceId = id(req.params.id), reason = clean(req.body?.reason, 3, 300);
    if (typeof req.body.paused !== 'boolean') fail('État incorrect');
    await transaction(async db => {
      const s = await space(spaceId, req.user.id, db, true);
      await db.query('UPDATE letchat_spaces SET paused=$2,moderation_reason=$3 WHERE id=$1', [spaceId, req.body.paused, reason]);
      await log(db, req, req.body.paused ? 'space_paused' : 'space_resumed', s, s.owner_id, reason);
    });
    await emit(spaceId); res.json({ ok: true });
  }));
  return {
    async purge() { await pool.query('DELETE FROM letchat_space_messages WHERE expires_at<=NOW()'); },
    async exportData(uid) { return {
      owned: (await pool.query('SELECT id,name,description,theme,rules,archived,created_at FROM letchat_spaces WHERE owner_id=$1', [uid])).rows,
      memberships: (await pool.query('SELECT space_id,role,accepted_version,joined_at FROM letchat_space_members WHERE user_id=$1 AND NOT banned', [uid])).rows,
      messages: (await pool.query('SELECT id,space_id,body,created_at,expires_at FROM letchat_space_messages WHERE user_id=$1 AND expires_at>NOW()', [uid])).rows
    }; }
  };
}
