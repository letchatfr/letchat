import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { SignJWT } from 'jose';
import { io } from 'socket.io-client';
import { createDiagnostics } from '../lib/diagnostics.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await freePort(), dbPort = await freePort(), origin = `http://127.0.0.1:${port}`;
const secret = 'v3-test-only-secret-at-least-32-characters';
const db = await PGlite.create(), database = new PGLiteSocketServer({ db, port: dbPort, host: '127.0.0.1', maxConnections: 20 });
let child, pool, logs = '', checks = 0; const sockets = [];
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };
async function request(path, token, method = 'GET', body) {
  const res = await fetch(origin + path, { method, signal: AbortSignal.timeout(15000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text };
}
async function connect(account) {
  const s = io(origin, { auth: { token: account.token }, transports: ['websocket'], reconnection: false }); sockets.push(s);
  await Promise.race([once(s, 'connect'), once(s, 'connect_error').then(([e]) => Promise.reject(e)), wait(5000).then(() => { throw new Error('socket timeout'); })]); return s;
}
const surprise = (s, kind, payload = {}) => new Promise((resolve, reject) => s.timeout(5000).emit(`surprise-${kind}`, payload, (e, result) => e ? reject(e) : resolve(result)));
try {
  await database.start(); const connectionString = `postgresql://postgres:test-only@127.0.0.1:${dbPort}/postgres`; pool = new pg.Pool({ connectionString });
  child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DATABASE_URL: connectionString, JWT_SECRET: secret, NODE_ENV: 'test', ADMIN_UID: 'local:v3-admin', ADMIN_EMAIL: '', STRIPE_SECRET_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', METERED_DOMAIN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let ready = false; for (let n = 0; n < 150; n++) { try { if ((await request('/api/ready')).status === 200) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  const register = async (username, guest = false) => {
    const r = await request(guest ? '/api/auth/guest' : '/api/auth/register', null, 'POST', { username, password: 'V3-test-password-123', age: 30, city: 'Testville', gender: 'neutral' });
    assert.equal(r.status, 201, r.text); await request('/api/rules-accept', r.data.token, 'POST', { accepted: true }); return r.data;
  };
  const a = await register('Alice V3'), b = await register('Bruno V3'), c = await register('Chloe V3'), g = await register('Guest V3', true);
  await pool.query("INSERT INTO profiles(user_id,display_name,region,department,city) VALUES('local:v3-admin','Admin V3','','','Test')");
  await pool.query("INSERT INTO letchat_local_accounts(user_id,username,username_key,is_guest) VALUES('local:v3-admin','Admin V3','admin-v3',FALSE)");
  const admin = await new SignJWT({ ver: 0 }).setProtectedHeader({ alg: 'HS256' }).setIssuer('letchat-local').setAudience('letchat').setSubject('local:v3-admin').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  for (const path of ['/api/spaces', '/api/message-search?q=hello', '/api/notification-preferences', '/api/admin/diagnostics']) check((await request(path)).status === 401, `${path} requires authentication`);
  const publicMessage = await request('/api/messages', a.token, 'POST', { room: 'cafe', body: 'Voici un message avant correction' });
  assert.equal(publicMessage.status, 201, publicMessage.text); const mid = publicMessage.data.id;
  check((await request(`/api/messages/public/${mid}`, b.token, 'PATCH', { body: 'Intrusion', previousBody: publicMessage.data.body })).status === 404, 'another member cannot edit a message');
  const corrected = await request(`/api/messages/public/${mid}`, a.token, 'PATCH', { body: 'Voici le message corrigé à 100%', previousBody: publicMessage.data.body });
  check(corrected.status === 200 && corrected.data.edited_at, 'author can edit text with a visible edit timestamp');
  check(corrected.data.expires_at === publicMessage.data.expires_at, 'editing does not extend the 48-hour lifetime');
  check((await request(`/api/messages/public/${mid}`, a.token, 'PATCH', { body: 'Ancienne copie', previousBody: publicMessage.data.body })).status === 409, 'stale edits are rejected');
  const read = await request('/api/messages?room=cafe', b.token);
  check(read.data.some(m => String(m.id) === String(mid) && m.edited_at && m.body.includes('corrigé')), 'history includes the edited message');
  check((await request('/api/message-search?kind=public&scope=cafe&q=100%25', b.token)).data.items.length === 1, 'search treats percent as literal text');
  check((await request('/api/message-search?kind=public&scope=cafe&q=%25%25', b.token)).data.items.length === 0, 'wildcards cannot broaden message search');
  await pool.query("UPDATE letchat_room_settings SET read_only=TRUE WHERE room='cafe'");
  check((await request(`/api/messages/public/${mid}`, a.token, 'PATCH', { body: 'No edit', previousBody: corrected.data.body })).status === 403, 'read-only rooms also prevent edits');
  await pool.query("UPDATE letchat_room_settings SET read_only=FALSE WHERE room='cafe'");
  const dm = await request('/api/private', a.token, 'POST', { recipientId: b.user.id, body: 'Confidentiel V3 alpha' }); assert.equal(dm.status, 201, dm.text);
  check((await request(`/api/message-search?kind=private&scope=${encodeURIComponent(b.user.id)}&q=Confidentiel`, c.token)).data.items.length === 0, 'a third person cannot search someone else’s private conversation');
  check((await request(`/api/message-search?kind=private&scope=${encodeURIComponent(a.user.id)}&q=Confidentiel`, b.token)).data.items.length === 1, 'recipient can search their own private conversation');
  await request(`/api/blocks/${a.user.id}`, b.token, 'POST');
  check((await request(`/api/messages/private/${dm.data.id}`, a.token, 'PATCH', { body: 'Contournement', previousBody: dm.data.body })).status === 403, 'blocking also prevents message edits');
  check((await request(`/api/message-search?kind=private&scope=${encodeURIComponent(a.user.id)}&q=Confidentiel`, b.token)).data.items.length === 0, 'blocked messages are absent from search');
  await request(`/api/blocks/${a.user.id}`, b.token, 'DELETE');
  await request(`/api/private-conversations/${a.user.id}`, b.token, 'DELETE');
  check((await request(`/api/message-search?kind=private&scope=${encodeURIComponent(a.user.id)}&q=Confidentiel`, b.token)).data.items.length === 0, 'cleared conversations do not reappear in search');
  await pool.query('UPDATE letchat_messages SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE id=$1', [mid]);
  check((await request(`/api/messages/public/${mid}`, a.token, 'PATCH', { body: 'Resurrect', previousBody: corrected.data.body })).status === 404, 'expired messages cannot be edited or resurrected');
  const premiumRoom = (await import('../public/room-catalog.js')).rooms; const premiumId = Object.keys(premiumRoom).find(id => premiumRoom[id].premium);
  check((await request(`/api/message-search?kind=public&scope=${premiumId}&q=test`, a.token)).status === 403, 'Premium access is enforced on search');
  const payload = { name: 'Musique V3', theme: 'musique', description: 'Nos découvertes musicales et concerts.', rules: 'Respectez les goûts de chacun et évitez la publicité.' };
  check((await request('/api/spaces', g.token, 'POST', payload)).status === 403, 'temporary accounts cannot create communities');
  const made = await request('/api/spaces', a.token, 'POST', payload); assert.equal(made.status, 201, made.text); const sid = made.data.id;
  check(made.data.joined && made.data.owner_id === a.user.id, 'creator becomes the community owner and member');
  check((await request(`/api/spaces/${sid}/messages`, b.token)).status === 403, 'non-members cannot read community messages');
  check((await request(`/api/spaces/${sid}/join`, b.token, 'POST', { rulesVersion: 999 })).status === 409, 'join requires the current rules version');
  check((await request(`/api/spaces/${sid}/join`, b.token, 'POST', { rulesVersion: 1 })).status === 200, 'member joins after accepting the rules');
  await request(`/api/spaces/${sid}/join`, c.token, 'POST', { rulesVersion: 1 });
  const post = await request(`/api/spaces/${sid}/messages`, b.token, 'POST', { body: 'Une musique pour dimanche' }); assert.equal(post.status, 201, post.text);
  check((new Date(post.data.expires_at) - new Date(post.data.created_at)) === 48 * 3600000, 'community messages also expire after 48 hours');
  check((await request(`/api/spaces/${sid}/messages`, c.token)).data.items.length === 1, 'joined members can read the conversation');
  check((await request(`/api/spaces/${sid}/messages/${post.data.id}`, c.token, 'DELETE', { reason: 'Pas autorisé' })).status === 403, 'ordinary members cannot moderate another member’s messages');
  const report = await request('/api/reports', c.token, 'POST', { reportedId: b.user.id, messageKind: 'community', messageId: post.data.id, reason: 'other', details: 'Signalement de test' });
  check(report.status === 201, 'community message reports reach the existing moderation workflow');
  const reports = await request('/api/admin/reports?kind=community', admin);
  const reportRow = reports.data.items.find(r => String(r.message_id) === String(post.data.id));
  check(Boolean(reportRow?.evidence_body), 'moderators receive a server-verified report excerpt');
  check((await request(`/api/admin/reports/${reportRow.id}/message`, admin, 'DELETE', { reason: 'Test de suppression' })).status === 200, 'administrator can remove a reported community message');
  check((await request(`/api/spaces/${sid}/messages`, c.token)).data.items.length === 0, 'removed community message disappears');
  const updated = await request(`/api/spaces/${sid}`, a.token, 'PATCH', { ...payload, rules: 'Nouvelles règles : courtoisie et un sujet musical par message.', rulesVersion: 1, archived: false });
  check(updated.status === 200 && updated.data.rules_version === 2, 'changing community rules increments their version');
  check((await request(`/api/spaces/${sid}/messages`, b.token, 'POST', { body: 'Before consent' })).status === 409, 'members must read changed rules before posting');
  await request(`/api/spaces/${sid}/join`, b.token, 'POST', { rulesVersion: 2 });
  await request(`/api/spaces/${sid}/join`, a.token, 'POST', { rulesVersion: 2 });
  check((await request(`/api/spaces/${sid}/messages`, b.token, 'POST', { body: 'Après les nouvelles règles' })).status === 201, 'posting resumes after accepting updated rules');
  check((await request(`/api/spaces/${sid}/members/${b.user.id}`, a.token, 'PATCH', { action: 'moderator', reason: 'Aide à la modération' })).status === 200, 'owner can appoint a moderator');
  check((await request(`/api/spaces/${sid}/members/${c.user.id}`, b.token, 'PATCH', { action: 'transfer', reason: 'Escalade interdite' })).status === 403, 'moderator cannot transfer ownership');
  check((await request(`/api/spaces/${sid}/members/${c.user.id}`, b.token, 'PATCH', { action: 'ban', reason: 'Exclusion de test' })).status === 200, 'moderator can exclude a regular member');
  check((await request(`/api/spaces/${sid}/messages`, c.token)).status === 403, 'excluded member cannot read messages');
  check((await request(`/api/spaces/${sid}/join`, c.token, 'POST', { rulesVersion: 2 })).status === 403, 'excluded member cannot rejoin');
  await request(`/api/spaces/${sid}/members/${c.user.id}`, a.token, 'PATCH', { action: 'unban', reason: 'Fin du test' });
  check((await request(`/api/admin/spaces/${sid}`, admin, 'PATCH', { paused: true, reason: 'Vérification de modération' })).status === 200, 'administrator can pause a community');
  check((await request(`/api/spaces/${sid}/messages`, b.token, 'POST', { body: 'Pause test' })).status === 403, 'paused community refuses new messages');
  await request(`/api/admin/spaces/${sid}`, admin, 'PATCH', { paused: false, reason: 'Fin de la pause' });
  await request(`/api/blocks/${a.user.id}`, c.token, 'POST');
  check(!(await request('/api/spaces', c.token)).data.items.some(s => s.id === sid), 'communities from blocked owners are hidden');
  check((await request(`/api/spaces/${sid}/messages`, c.token)).status === 403, 'blocked owner access cannot be bypassed with a direct URL');
  await request(`/api/blocks/${a.user.id}`, c.token, 'DELETE');
  const prefs = { private_messages: false, friendships: true, preview: false, quietHours: 8 };
  check((await request('/api/notification-preferences', b.token, 'PATCH', prefs)).status === 200, 'push categories, private preview and pause can be configured');
  const saved = (await request('/api/notification-preferences', b.token)).data;
  check(saved.private_messages === false && saved.preview === false && new Date(saved.quiet_until) > new Date(), 'notification choices persist');
  check((await request('/api/notification-preferences', b.token, 'PATCH', { ...prefs, quietHours: 900 })).status === 400, 'invalid notification pause is rejected');
  check((await request('/api/admin/diagnostics', b.token)).status === 403, 'operational diagnostics are administrator-only');
  check((await request('/api/diagnostics/events', b.token, 'POST', { event: 'call_failed', message: 'PRIVATE' })).status === 400, 'telemetry rejects arbitrary message content');
  check((await request('/api/diagnostics/events', b.token, 'POST', { event: 'call_failed' })).status === 204, 'allowed operational events are aggregated');
  const diagnostics = (await request('/api/admin/diagnostics', admin)).data;
  check(diagnostics.events.call_failed === 1 && !JSON.stringify(diagnostics).includes(b.user.id), 'diagnostics store no member identifiers');
  let clock = Date.now(); const metrics = createDiagnostics({ now: () => clock }); metrics.record('client_error'); clock += 25 * 3600000;
  check(!metrics.snapshot().events.client_error, 'operational aggregates expire after the 24-hour window');
  const sa = await connect(a), sb = await connect(b), sc = await connect(c);
  sa.emit('join-room', 'actualites'); await wait(150);
  await surprise(sa, 'join', { mode: 'video', interests: ['musique'] });
  check((await surprise(sb, 'join', { mode: 'text', interests: ['musique'] })).state.status === 'waiting', 'text and video preferences never silently mix');
  const match = await surprise(sc, 'join', { mode: 'video', interests: ['musique'] });
  check(match.state.status === 'matched' && match.state.partner.id === a.user.id && match.state.partner.socketId === sa.id, 'two video volunteers receive an explicit call target');
  check((await surprise(sb, 'status')).state.partner === null, 'unmatched user receives no call identifiers');
  const callId = crypto.randomUUID();
  const incoming = once(sa, 'webrtc'); sc.emit('webrtc', { target: sa.id, data: { type: 'invite', callId } });
  const [call] = await Promise.race([incoming, wait(5000).then(() => { throw new Error('Video invitation failed'); })]);
  check(call.data.type === 'invite', 'matched video volunteers can invite each other across public rooms');
  const ended = once(sc, 'webrtc'); await surprise(sa, 'leave');
  check((await ended)[0].data.type === 'leave', 'leaving Surprise immediately terminates its video invitation');
  await surprise(sb, 'leave'); await surprise(sc, 'leave');
  for (const s of sockets) s.disconnect();
  const exported = (await request('/api/account-export', a.token)).data;
  check(exported.communities.owned.some(s => s.id === sid) && exported.notificationPreferences, 'account export includes communities and notification preferences');
  const map = await request('/sitemap.xml');
  const urls = [...map.text.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  check(urls.includes('https://www.letchat.fr/guides/'), 'guide hub is in the sitemap');
  for (const url of urls.filter(u => u.includes('/guides/'))) {
    const route = new URL(url).pathname, page = await request(route);
    check(page.status === 200 && page.text.includes(`href="${url}"`) && (page.text.match(/<h1>/g) || []).length === 1, `${route} is reachable with one heading and a matching canonical`);
  }
  const html = await request('/');
  check((html.text.match(/rel="stylesheet"/g) || []).length === 1, 'the interface loads one consolidated stylesheet');
  check(!logs.includes('Erreur serveur'), 'no unexpected server errors during V3 scenarios');
  console.log(`${checks} V3 integration checks passed.`);
} catch (error) { console.error(error); console.error(logs); process.exitCode = 1; }
finally {
  for (const s of sockets) s.disconnect();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await pool?.end(); await database.stop(); await wait(100); await db.close();
}
