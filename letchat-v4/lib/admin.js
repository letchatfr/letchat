import { serveMedia } from "./media.js";
// Administration: explicit projections, bounded lists and atomic audit trails.
const clean = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };
const positiveId = value => { if (!/^[1-9]\d{0,17}$/.test(String(value))) fail('Identifiant incorrect'); return String(value); };
const reasonFor = body => { const reason = clean(body?.reason, 500); if (reason.length < 3) fail('Indiquez un motif de 3 à 500 caractères.'); return reason; };
const paging = req => { const page = Math.min(10000, Math.max(1, Number.parseInt(req.query.page, 10) || 1)); return { page, limit: 30, offset: (page - 1) * 30 }; };
const activeSuspension = `(s.user_id IS NOT NULL AND (s.suspended_until IS NULL OR s.suspended_until>NOW()))`;
const activePremium = `(sub.status IN ('active','trialing') AND (sub.current_period_end IS NULL OR sub.current_period_end>NOW()))`;
export async function installAdmin({ app, pool, io, auth, adminAuth, isAdminUser, rateLimitAction, roomCatalog, getOnline, emitPresence, insertNotification, publishNotification, social, pushConfigured, billingConfigured }) {
  await pool.query(`
    ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS assigned_to TEXT;
    ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS context_label TEXT NOT NULL DEFAULT '';
    ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS content_removed_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS letchat_room_settings (
      room TEXT PRIMARY KEY, read_only BOOLEAN NOT NULL DEFAULT FALSE,
      slow_seconds INTEGER NOT NULL DEFAULT 0, notice TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_reports_target ON letchat_reports(reported_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_log_target ON letchat_moderation_log(target_user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_messages_room ON letchat_messages(room,created_at DESC);
  `);
  for (const room of Object.keys(roomCatalog).filter(k => k !== 'messages'))
    await pool.query('INSERT INTO letchat_room_settings(room) VALUES($1) ON CONFLICT DO NOTHING', [room]);
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const base = [auth, adminAuth];
  const write = [...base, rateLimitAction('admin-write', 120, 60000)];
  async function tx(fn) {
    const db = await pool.connect(); let broken = false;
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (e) { try { await db.query('ROLLBACK'); } catch { broken = true; } throw e; }
    finally { db.release(broken); }
  }
  async function log(db, req, action, target = null, details = '', report = null) {
    await db.query(`INSERT INTO letchat_moderation_log(admin_id,admin_name,action,target_user_id,details,report_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [req.user.id, req.user.name || 'Administrateur', action, target, clean(details), report]);
  }
  async function target(db, id, protect = false) {
    const row = (await db.query('SELECT user_id,display_name,email FROM profiles WHERE user_id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) fail('Membre introuvable', 404);
    if (protect && isAdminUser({ id: row.user_id, email: row.email })) fail('Ce compte administrateur est protégé.', 403);
    return row;
  }
  function refreshProfile(id, patch) {
    for (const [sid, entry] of getOnline()) if (entry.user.id === id) {
      entry.user.profile = { ...(entry.user.profile || {}), ...patch };
      if ('photo' in patch) entry.user.photo = patch.photo;
      getOnline().set(sid, entry); emitPresence(entry.room);
    }
    io.to(`user:${id}`).emit('profile-moderated', patch);
  }
  const onlineIds = () => [...new Set([...getOnline().values()].map(e => e.user.id))];
  async function list(req, res, from, where, values, fields, order) {
    const { page, limit, offset } = paging(req), n = values.length;
    const count = await pool.query(`SELECT COUNT(*)::int AS total ${from} WHERE ${where}`, values);
    const rows = await pool.query(`SELECT ${fields} ${from} WHERE ${where} ORDER BY ${order} LIMIT $${n + 1} OFFSET $${n + 2}`, [...values, limit, offset]);
    res.json({ items: rows.rows, total: count.rows[0].total, page, pageSize: limit });
  }
  app.get('/api/admin/stats', ...base, wrap(async (_req, res) => {
    const result = (await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM profiles) AS users,
      (SELECT COUNT(*)::int FROM letchat_local_accounts WHERE NOT is_guest) AS accounts,
      (SELECT COUNT(*)::int FROM letchat_local_accounts WHERE is_guest AND expires_at>NOW()) AS guests,
      (SELECT COUNT(*)::int FROM letchat_local_accounts WHERE created_at>NOW()-INTERVAL '24 hours') AS new24h,
      (SELECT COUNT(*)::int FROM letchat_messages WHERE created_at>NOW()-INTERVAL '24 hours') AS public24h,
      (SELECT COUNT(*)::int FROM letchat_private_messages WHERE created_at>NOW()-INTERVAL '24 hours') AS private24h,
      (SELECT COUNT(*)::int FROM letchat_group_messages WHERE created_at>NOW()-INTERVAL '24 hours') AS group24h,
      (SELECT COUNT(*)::int FROM letchat_reports WHERE status='pending') AS "pendingReports",
      (SELECT COUNT(*)::int FROM letchat_reports WHERE status='pending' AND priority='urgent') AS urgent,
      (SELECT COUNT(*)::int FROM letchat_reports WHERE status='pending' AND created_at<NOW()-INTERVAL '24 hours') AS overdue,
      (SELECT COUNT(*)::int FROM letchat_suspensions WHERE suspended_until IS NULL OR suspended_until>NOW()) AS "activeSuspensions",
      (SELECT COUNT(*)::int FROM letchat_subscriptions WHERE status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end>NOW())) AS premium,
      (SELECT COUNT(*)::int FROM letchat_groups) AS groups`)).rows[0];
    result.online = onlineIds().length; result.messages24h = result.public24h + result.private24h + result.group24h;
    res.json({ ...result, updatedAt: new Date().toISOString() });
  }));
  const memberFrom = `FROM profiles p LEFT JOIN letchat_local_accounts a ON a.user_id=p.user_id
    LEFT JOIN letchat_suspensions s ON s.user_id=p.user_id LEFT JOIN letchat_subscriptions sub ON sub.user_id=p.user_id`;
  app.get('/api/admin/profiles', ...base, wrap(async (req, res) => {
    const q = clean(req.query.q, 100), filter = clean(req.query.filter, 30), ids = onlineIds();
    const where = `($1='' OR p.display_name ILIKE '%'||$1||'%' OR p.email ILIKE '%'||$1||'%' OR p.city ILIKE '%'||$1||'%' OR p.user_id=$1 OR a.username ILIKE '%'||$1||'%')
      AND ($2='' OR ($2='suspended' AND ${activeSuspension}) OR ($2='premium' AND ${activePremium}) OR ($2='verified' AND p.verified)
        OR ($2='guest' AND a.is_guest) OR ($2='online' AND p.user_id=ANY($3::text[])))`;
    await list(req, res, memberFrom, where, [q, filter, ids], `p.user_id,p.display_name,p.email,p.city,p.verified,p.last_seen,a.is_guest,a.username,
      COALESCE(${activePremium},FALSE) AS premium,${activeSuspension} AS suspended,p.user_id=ANY($3::text[]) AS online`, 'p.updated_at DESC,p.user_id');
  }));
  app.get('/api/admin/profiles/:userId', ...base, wrap(async (req, res) => {
    const id = clean(req.params.userId, 200);
    const profile = (await pool.query(`SELECT p.user_id,p.display_name,p.email,p.city,p.bio,p.photo IS NOT NULL AS has_photo,p.verified,p.last_seen,p.updated_at,
      a.username,a.is_guest,a.created_at,a.expires_at,s.reason AS suspension_reason,s.suspended_until,${activeSuspension} AS suspended,
      sub.plan,sub.status AS subscription_status,sub.current_period_end,COALESCE(${activePremium},FALSE) AS premium ${memberFrom} WHERE p.user_id=$1`, [id])).rows[0];
    if (!profile) fail('Membre introuvable', 404);
    const history = (await pool.query(`SELECT id,action,admin_name,details,created_at,report_id FROM letchat_moderation_log WHERE target_user_id=$1 ORDER BY id DESC LIMIT 20`, [id])).rows;
    const counts = (await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM letchat_reports WHERE reported_id=$1) AS reports,
      (SELECT COUNT(*)::int FROM letchat_messages WHERE user_id=$1) AS public_messages,
      (SELECT COUNT(*)::int FROM letchat_group_members WHERE user_id=$1 AND status='accepted') AS groups`, [id])).rows[0];
    res.json({ ...profile, protected: isAdminUser({ id, email: profile.email }), online: onlineIds().includes(id), history, counts });
  }));
  app.patch('/api/admin/profiles/:userId/verification', ...write, wrap(async (req, res) => {
    if (typeof req.body?.verified !== 'boolean') fail('Valeur de vérification incorrecte');
    const id = clean(req.params.userId, 200), verified = req.body.verified;
    const row = await tx(async db => { await target(db, id); const r = (await db.query('UPDATE profiles SET verified=$1,updated_at=NOW() WHERE user_id=$2 RETURNING user_id,display_name,verified', [verified,id])).rows[0];
      await log(db, req, verified ? 'profile_verified' : 'profile_unverified', id, 'Badge de vérification'); return r; });
    refreshProfile(id, { verified }); res.json(row);
  }));
  app.post('/api/admin/profiles/:userId/actions', ...write, wrap(async (req, res) => {
    const id = clean(req.params.userId, 200), action = clean(req.body?.action, 30), reason = reasonFor(req.body);
    if (!['note','warn','clear_bio','clear_photo','revoke_sessions'].includes(action)) fail('Action inconnue');
    const notification = await tx(async db => {
      // Account before profile, matching recovery, private send and account deletion.
      if (action === 'revoke_sessions') await db.query('SELECT user_id FROM letchat_local_accounts WHERE user_id=$1 FOR UPDATE', [id]);
      await target(db, id, action !== 'note');
      let notification;
      if (action === 'clear_bio') await db.query("UPDATE profiles SET bio='',updated_at=NOW() WHERE user_id=$1", [id]);
      if (action === 'clear_photo') {
        await db.query('UPDATE profiles SET photo=NULL,updated_at=NOW() WHERE user_id=$1', [id]);
        await db.query('UPDATE letchat_messages SET photo=NULL WHERE user_id=$1', [id]);
        await db.query('UPDATE letchat_private_messages SET sender_photo=NULL WHERE sender_id=$1', [id]);
      }
      if (action === 'revoke_sessions') {
        await db.query('UPDATE letchat_local_accounts SET session_version=session_version+1 WHERE user_id=$1', [id]);
        await db.query(`INSERT INTO letchat_session_revocations(user_id,revoked_before) VALUES($1,NOW())
          ON CONFLICT(user_id) DO UPDATE SET revoked_before=NOW()`, [id]);
      }
      if (action === 'warn') notification = await insertNotification(db, id, 'moderation_warning', 'Avertissement de la modération', reason);
      await log(db, req, action, id, reason); return notification;
    });
    if (notification) publishNotification(id, notification);
    if (action === 'revoke_sessions') { io.to(`user:${id}`).emit('session-revoked'); io.in(`user:${id}`).disconnectSockets(true); }
    if (action === 'clear_photo') refreshProfile(id, { photo: null });
    if (action === 'clear_bio') refreshProfile(id, { bio: '' });
    res.json({ ok: true });
  }));
  app.post('/api/admin/suspensions/:userId', ...write, wrap(async (req, res) => {
    const id = clean(req.params.userId, 200), reason = reasonFor(req.body), duration = clean(req.body?.duration, 20);
    const durations = { '1h': '1 hour', '24h': '1 day', '7d': '7 days', '30d': '30 days', permanent: null };
    if (!Object.hasOwn(durations, duration)) fail('Durée incorrecte');
    await tx(async db => { await target(db, id, true);
      await db.query(`INSERT INTO letchat_suspensions(user_id,suspended_until,reason,updated_by)
        VALUES($1,CASE WHEN $2::text IS NULL THEN NULL ELSE NOW()+$2::interval END,$3,$4)
        ON CONFLICT(user_id) DO UPDATE SET suspended_until=EXCLUDED.suspended_until,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [id,durations[duration],reason,req.user.id]);
      await log(db, req, 'user_suspended', id, `${duration} — ${reason}`);
    });
    io.in(`user:${id}`).disconnectSockets(true); res.json({ ok: true });
  }));
  app.delete('/api/admin/suspensions/:userId', ...write, wrap(async (req, res) => {
    const id = clean(req.params.userId, 200), reason = reasonFor(req.body);
    await tx(async db => { await target(db, id, true); const r = await db.query('DELETE FROM letchat_suspensions WHERE user_id=$1', [id]);
      if (r.rowCount) await log(db, req, 'user_unsuspended', id, reason); }); res.json({ ok: true });
  }));
  app.get('/api/admin/reports', ...base, wrap(async (req, res) => {
    const status = clean(req.query.status, 20) || 'pending', kind = clean(req.query.kind, 20), priority = clean(req.query.priority, 20), q = clean(req.query.q, 100), mine = req.query.mine === 'true';
    await list(req, res, `FROM letchat_reports r LEFT JOIN profiles reporter ON reporter.user_id=r.reporter_id
      LEFT JOIN profiles reported ON reported.user_id=r.reported_id LEFT JOIN profiles assignee ON assignee.user_id=r.assigned_to`,
    `($1='all' OR r.status=$1) AND ($2='' OR COALESCE(r.message_kind,'profile')=$2) AND ($3='' OR r.priority=$3)
      AND ($4='' OR reported.display_name ILIKE '%'||$4||'%' OR reporter.display_name ILIKE '%'||$4||'%' OR r.id::text=$4)
      AND (NOT $5 OR r.assigned_to=$6)`, [status,kind,priority,q,mine,req.user.id],
    `r.*,COALESCE(reporter.display_name,'Compte supprimé') AS reporter_name,COALESCE(reported.display_name,'Compte supprimé') AS reported_name,
      assignee.display_name AS assignee_name,
      CASE r.message_kind WHEN 'public' THEN EXISTS(SELECT 1 FROM letchat_messages m WHERE m.id=r.message_id AND m.expires_at>NOW() AND m.media_data IS NOT NULL)
        WHEN 'private' THEN EXISTS(SELECT 1 FROM letchat_private_messages m WHERE m.id=r.message_id AND m.expires_at>NOW() AND m.media_data IS NOT NULL)
        WHEN 'group' THEN EXISTS(SELECT 1 FROM letchat_group_messages m WHERE m.id=r.message_id AND m.expires_at>NOW() AND m.media_data IS NOT NULL) ELSE FALSE END AS media_available`, "CASE r.priority WHEN 'urgent' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC");
  }));
  app.get('/api/admin/reports/:id/media', ...base, wrap(async (req,res) => {
    const report = (await pool.query('SELECT message_kind,message_id FROM letchat_reports WHERE id=$1',[positiveId(req.params.id)])).rows[0];
    const tables = { public: 'letchat_messages', private: 'letchat_private_messages', group: 'letchat_group_messages' };
    if (!report?.message_id || !tables[report.message_kind]) fail('Pièce jointe indisponible',404);
    const row = (await pool.query(`SELECT media_data,media_type FROM ${tables[report.message_kind]} WHERE id=$1 AND expires_at>NOW()`,[report.message_id])).rows[0];
    if (!row?.media_data) fail('Pièce jointe supprimée ou expirée',404);
    serveMedia(res,row.media_data,row.media_type);
  }));
  app.patch('/api/admin/reports/:id', ...write, wrap(async (req, res) => {
    const id = positiveId(req.params.id), b = req.body || {};
    if (b.status !== undefined && !['pending','resolved','dismissed'].includes(b.status)) fail('Statut incorrect');
    if (b.priority !== undefined && !['normal','urgent'].includes(b.priority)) fail('Priorité incorrecte');
    if (b.assignment !== undefined && !['me','none'].includes(b.assignment)) fail('Attribution incorrecte');
    const result = await tx(async db => {
      const old = (await db.query('SELECT * FROM letchat_reports WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old) fail('Signalement introuvable', 404);
      if (b.expectedStatus && old.status !== b.expectedStatus) fail('Ce signalement a changé. Actualisez la liste.', 409);
      const status = b.status ?? old.status, note = b.note === undefined ? old.admin_note : clean(b.note, 2000);
      if (b.status && b.status !== old.status && status !== 'pending' && note.length < 3) fail('Ajoutez une note expliquant votre décision.');
      const row = (await db.query(`UPDATE letchat_reports SET status=$2,priority=$3,assigned_to=$4,admin_note=$5,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id,status,b.priority ?? old.priority,b.assignment === 'me' ? req.user.id : b.assignment === 'none' ? null : old.assigned_to,note])).rows[0];
      await log(db, req, 'report_updated', old.reported_id, `Statut : ${status}. Priorité : ${row.priority}. Attribution : ${b.assignment || 'inchangée'}. ${note}`, id);
      let notification;
      if (status !== old.status && !old.reporter_id.startsWith('deleted:') && (await db.query('SELECT 1 FROM profiles WHERE user_id=$1', [old.reporter_id])).rowCount)
        notification = await insertNotification(db, old.reporter_id, 'report_update', 'Mise à jour de votre signalement', status === 'pending' ? 'Votre signalement a été rouvert pour examen.' : 'Votre signalement a été examiné par la modération.', null, id);
      return { row, notification };
    });
    if (result.notification) publishNotification(result.row.reporter_id, result.notification);
    res.json({ ok: true, status: result.row.status });
  }));
  async function deleteMessage(db, kind, id) {
    let row;
    if (kind === 'public') row = (await db.query('DELETE FROM letchat_messages WHERE id=$1 RETURNING user_id,room', [id])).rows[0];
    else if (kind === 'private') row = (await db.query('DELETE FROM letchat_private_messages WHERE id=$1 RETURNING sender_id AS user_id,recipient_id', [id])).rows[0];
    else if (kind === 'group') row = (await db.query('DELETE FROM letchat_group_messages WHERE id=$1 RETURNING sender_id AS user_id,group_id', [id])).rows[0];
    else fail('Type de message incorrect');
    if (kind !== 'group') await db.query('DELETE FROM letchat_message_reactions WHERE message_kind=$1 AND message_id=$2', [kind,id]);
    await db.query('UPDATE letchat_reports SET content_removed_at=NOW() WHERE message_kind=$1 AND message_id=$2', [kind,id]);
    return row;
  }
  async function emitDeleted(kind, id, row) {
    if (!row) return;
    if (kind === 'group') {
      const members = (await pool.query('SELECT user_id FROM letchat_group_members WHERE group_id=$1', [row.group_id])).rows;
      for (const m of members) io.to(`user:${m.user_id}`).emit('social-update', { kind: 'group', id: row.group_id });
    } else {
      const destination = kind === 'public' ? io.to(row.room) : io.to(`user:${row.user_id}`).to(`user:${row.recipient_id}`);
      destination.emit('message-deleted', { id: String(id), private: kind === 'private' });
    }
  }
  app.delete('/api/admin/reports/:id/message', ...write, wrap(async (req, res) => {
    const id = positiveId(req.params.id), reason = reasonFor(req.body);
    const result = await tx(async db => {
      const report = (await db.query('SELECT * FROM letchat_reports WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!report?.message_id) fail('Aucun message associé à ce signalement', 404);
      const row = await deleteMessage(db, report.message_kind, report.message_id);
      if (row) await log(db, req, 'message_deleted', report.reported_id, `${report.message_kind} n°${report.message_id} — ${reason}`, id);
      return { report, row };
    });
    await emitDeleted(result.report.message_kind, result.report.message_id, result.row); res.json({ ok: true, alreadyDeleted: !result.row });
  }));
  app.get('/api/rooms/:room/moderation', auth, wrap(async (req,res) => {
    const row=(await pool.query('SELECT room,read_only,slow_seconds,notice FROM letchat_room_settings WHERE room=$1',[req.params.room])).rows[0];
    if(!row) fail('Salon introuvable',404);res.json(row);
  }));
  app.get('/api/admin/rooms', ...base, wrap(async (_req, res) => {
    const settings = (await pool.query('SELECT * FROM letchat_room_settings')).rows;
    const counts = (await pool.query("SELECT room,COUNT(*)::int AS messages FROM letchat_messages WHERE expires_at>NOW() GROUP BY room")).rows;
    res.json(Object.entries(roomCatalog).filter(([id]) => id !== 'messages').map(([id, room]) => ({ id, ...room, ...settings.find(s => s.room === id),
      messages: counts.find(r => r.room === id)?.messages || 0, online: new Set([...getOnline().values()].filter(e => e.room === id).map(e => e.user.id)).size })));
  }));
  app.patch('/api/admin/rooms/:room', ...write, wrap(async (req, res) => {
    const room = req.params.room, b = req.body || {}, reason = reasonFor(b);
    if (!roomCatalog[room] || room === 'messages') fail('Salon introuvable', 404);
    if (typeof b.readOnly !== 'boolean' || ![0,5,10,30,60].includes(b.slowSeconds)) fail('Paramètres du salon incorrects');
    const row = await tx(async db => {
      const r = (await db.query('UPDATE letchat_room_settings SET read_only=$2,slow_seconds=$3,notice=$4,updated_at=NOW() WHERE room=$1 RETURNING *', [room,b.readOnly,b.slowSeconds,clean(b.notice,300)])).rows[0];
      await log(db, req, 'room_updated', null, `${room}: lecture seule ${b.readOnly}, délai ${b.slowSeconds}s. ${reason}`); return r;
    });
    io.to(room).emit('room-moderated', { room, readOnly: row.read_only, notice: row.notice, slowSeconds: row.slow_seconds }); res.json(row);
  }));
  app.get('/api/admin/rooms/:room/messages', ...base, wrap(async (req,res) => {
    if (!roomCatalog[req.params.room] || req.params.room === 'messages') fail('Salon introuvable', 404);
    await list(req,res,'FROM letchat_messages', 'room=$1 AND expires_at>NOW() AND ($2=\'\' OR body ILIKE \'%\'||$2||\'%\' OR author ILIKE \'%\'||$2||\'%\')',
      [req.params.room,clean(req.query.q,100)], 'id,user_id,author,body,media_type,pinned,created_at', 'id DESC');
  }));
  app.delete('/api/admin/messages/:id', ...write, wrap(async (req,res) => {
    const id = positiveId(req.params.id), reason = reasonFor(req.body);
    const row = await tx(async db => { const row = await deleteMessage(db,'public',id); if (!row) fail('Message introuvable',404);
      await log(db,req,'message_deleted',row.user_id,`Salon ${row.room}, message ${id} — ${reason}`); return row; });
    await emitDeleted('public',id,row); res.json({ok:true});
  }));
  app.patch('/api/messages/:id/pin', ...write, wrap(async (req,res) => {
    const id = positiveId(req.params.id); if (typeof req.body?.pinned !== 'boolean') fail('Valeur incorrecte');
    const row = await tx(async db => { const row = (await db.query('UPDATE letchat_messages SET pinned=$2 WHERE id=$1 AND expires_at>NOW() RETURNING id,pinned,room,user_id',[id,req.body.pinned])).rows[0];
      if (!row) fail('Message introuvable',404); await log(db,req,row.pinned?'message_pinned':'message_unpinned',row.user_id,`Salon ${row.room}, message ${id}`); return row; });
    io.to(row.room).emit('message-pinned',row); res.json(row);
  }));
  app.get('/api/admin/groups', ...base, wrap(async (req,res) => {
    await list(req,res,`FROM letchat_groups g LEFT JOIN profiles p ON p.user_id=g.owner_id`,
      `($1='' OR g.name ILIKE '%'||$1||'%' OR p.display_name ILIKE '%'||$1||'%') AND ($2='' OR ($2='paused' AND g.paused))`,
      [clean(req.query.q,100),clean(req.query.filter,20)], `g.id,g.name,g.owner_id,g.created_at,g.paused,g.moderation_reason,p.display_name AS owner_name,
      (SELECT COUNT(*)::int FROM letchat_group_members m WHERE m.group_id=g.id AND m.status='accepted') AS members,
      (SELECT COUNT(*)::int FROM letchat_group_messages m WHERE m.group_id=g.id AND m.expires_at>NOW()) AS messages`, 'g.created_at DESC,g.id');
  }));
  app.patch('/api/admin/groups/:id', ...write, wrap(async (req,res) => {
    const id=clean(req.params.id,200), reason=reasonFor(req.body); if(typeof req.body?.paused!=='boolean') fail('Valeur incorrecte');
    await tx(async db => { const r=await db.query('UPDATE letchat_groups SET paused=$2,moderation_reason=$3 WHERE id=$1 RETURNING owner_id',[id,req.body.paused,reason]);
      if(!r.rowCount) fail('Groupe introuvable',404); await log(db,req,req.body.paused?'group_paused':'group_resumed',r.rows[0].owner_id,`Groupe ${id} — ${reason}`); });
    if(req.body.paused) social.live.closeScope(`group:${id}`);
    for(const m of (await pool.query('SELECT user_id FROM letchat_group_members WHERE group_id=$1',[id])).rows) io.to(`user:${m.user_id}`).emit('social-update',{kind:'group',id});
    res.json({ok:true});
  }));
  app.get('/api/admin/subscriptions', ...base, wrap(async (req,res) => {
    await list(req,res,'FROM letchat_subscriptions sub LEFT JOIN profiles p ON p.user_id=sub.user_id',
      `($1='' OR p.display_name ILIKE '%'||$1||'%' OR sub.user_id=$1) AND ($2='' OR sub.status=$2)`,[clean(req.query.q,100),clean(req.query.status,30)],
      `sub.user_id,p.display_name,sub.plan,sub.status,sub.current_period_end,sub.updated_at,COALESCE(${activePremium},FALSE) AS access_active`, 'sub.updated_at DESC,sub.user_id');
  }));
  app.get('/api/admin/moderation-log', ...base, wrap(async (req,res) => {
    await list(req,res,'FROM letchat_moderation_log l LEFT JOIN profiles p ON p.user_id=l.target_user_id',
      `($1='' OR l.action=$1) AND ($2='' OR l.admin_name ILIKE '%'||$2||'%' OR p.display_name ILIKE '%'||$2||'%' OR l.details ILIKE '%'||$2||'%')`,
      [clean(req.query.action,40),clean(req.query.q,100)],'l.*,p.display_name AS target_name','l.id DESC');
  }));
  app.get('/api/admin/system', ...base, wrap(async (_req,res) => {
    const start=Date.now(); await pool.query('SELECT 1');
    res.json({ database:true,databaseMs:Date.now()-start,uptimeSeconds:Math.floor(process.uptime()),pushConfigured,billingConfigured,
      adminCount:{ ids:String(process.env.ADMIN_UID||'').split(',').filter(x=>x.trim()).length,emails:String(process.env.ADMIN_EMAIL||'').split(',').filter(x=>x.trim()).length },
      version:'Administration · septembre 2026',retentionHours:48,serverTime:new Date().toISOString() });
  }));
  return { async withRoomWrite(user,room,fn) {
    return tx(async db => {
      const state=(await db.query('SELECT * FROM letchat_room_settings WHERE room=$1 FOR SHARE',[room])).rows[0];
      if(!state) fail('Ce salon ne permet pas l’envoi de messages.',400);
      if(!isAdminUser(user)) {
        if(state.read_only) fail('Ce salon est temporairement en lecture seule.'+(state.notice?' '+state.notice:''),403);
        if(state.slow_seconds) {
          await db.query('SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE',[user.id]);
          const last=(await db.query(`SELECT 1 FROM letchat_messages WHERE room=$1 AND user_id=$2 AND created_at>clock_timestamp()-($3::int*INTERVAL '1 second') LIMIT 1`,[room,user.id,state.slow_seconds])).rowCount;
          if(last) fail(`Mode lent : attendez ${state.slow_seconds} secondes entre deux messages.`,429);
        }
      }
      return fn(db);
    });
  }};
}
