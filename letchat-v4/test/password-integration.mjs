import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, scryptSync } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { SignJWT } from 'jose';
import { newRecoveryCode, recoveryHash } from '../lib/accounts.js';

const port = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const db = await PGlite.create(), dbPort = await port(), appPort = await port();
const bridge = new PGLiteSocketServer({ db, port: dbPort, host: '127.0.0.1', maxConnections: 20 });
const secret = 'password-test-isolated-secret-over-thirty-two-characters';
const origin = `http://127.0.0.1:${appPort}`;
let child, pool, logs = '', checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('✓ ' + label); };
const request = async (route, token, method = 'GET', body) => {
  const r = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json(), headers: r.headers };
};
const login = account => request('/api/auth/login', null, 'POST', { username: account.username, password: account.password });
const tokenFor = id => new SignJWT({ ver: 0 }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuer('letchat-local').setAudience('letchat').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
const seed = async (name, password = 'TEST-PAUSE-' + name) => {
  const id = 'local:password-test-' + name, salt = randomBytes(16).toString('hex'), recoveryCode = newRecoveryCode();
  // Simulates a real account created by the previous synchronous implementation.
  await pool.query('INSERT INTO letchat_local_accounts(user_id,username,username_key,password_hash,password_salt,recovery_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [id, name, name.toLocaleLowerCase('fr'), scryptSync(password, salt, 64).toString('hex'), salt, recoveryHash(recoveryCode)]);
  await pool.query("INSERT INTO profiles(user_id,display_name,region,department,city) VALUES($1,$2,'','','Testville')", [id, name]);
  await pool.query('INSERT INTO letchat_age_consents(user_id,over_18) VALUES($1,TRUE)', [id]);
  await pool.query("INSERT INTO letchat_consents(user_id,rules_version) VALUES($1,'2026-09-22-v1')", [id]);
  return { id, username: name, password, recoveryCode, token: await tokenFor(id) };
};
function paused(password) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.off('message', listener); reject(new Error('Password did not pause: ' + password)); }, 8000);
    function listener(message) {
      if (message?.type === 'password-paused' && message.password === password) {
        clearTimeout(timeout); child.off('message', listener); resolve();
      }
    }
    child.on('message', listener);
  });
}
const release = password => child.send({ type: 'release-password', password });
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
  }
}
async function start(connectionString) {
  child = spawn(process.execPath, ['--import', './test/password-pause.mjs', 'server.js'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: connectionString, PORT: String(appPort),
      JWT_SECRET: secret, ADMIN_UID: 'local:password-test-admin', ADMIN_EMAIL: '', STRIPE_SECRET_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 150; i++) {
    try { if ((await request('/api/health')).status === 200) return; } catch {}
    if (child.exitCode !== null) break;
    await wait(100);
  }
  throw new Error('Test server did not start\n' + logs);
}

try {
  await bridge.start();
  const connectionString = `postgresql://postgres:test@127.0.0.1:${dbPort}/postgres`;
  pool = new pg.Pool({ connectionString }); await start(connectionString);
  const admin = await seed('admin', 'Normal-admin-password'), sender = await seed('sender', 'Normal-sender-password'), recipient = await seed('recipient', 'Normal-recipient-password');
  const recovered = await seed('recovered');
  let held = paused(recovered.password), inFlight = login(recovered); await held;
  const reset = await request('/api/auth/recover', null, 'POST', { username: recovered.username, recoveryCode: recovered.recoveryCode, password: 'Replacement-password-123' });
  check(reset.status === 200, 'password recovery completes while an earlier login is paused');
  release(recovered.password);
  check((await inFlight).status === 401, 'login checked against the old password cannot obtain a new session after recovery');
  check((await login({ ...recovered, password: 'Replacement-password-123' })).status === 200, 'replacement password works');
  check((await login(recovered)).status === 401, 'old password remains rejected');

  const revoked = await seed('revoked');
  held = paused(revoked.password); inFlight = login(revoked); await held;
  const revoke = await request(`/api/admin/profiles/${revoked.id}/actions`, admin.token, 'POST', { action: 'revoke_sessions', reason: 'Concurrent login test' });
  check(revoke.status === 200, 'administrator can revoke sessions during password verification');
  release(revoked.password);
  check((await inFlight).status === 401, 'a login started before administrative revocation is rejected');
  check((await login(revoked)).status === 200, 'a fresh login after revocation still works');

  const deleted = await seed('deleted');
  held = paused(deleted.password); inFlight = login(deleted); await held;
  check((await request('/api/account', deleted.token, 'DELETE', { confirmation: 'SUPPRIMER' })).status === 200, 'account deletion completes during password verification');
  release(deleted.password);
  check((await inFlight).status === 401, 'deleted account cannot receive a session from a pending login');

  const rotated = await seed('rotated');
  held = paused(rotated.password);
  inFlight = request('/api/account/recovery-code', rotated.token, 'POST', { password: rotated.password }); await held;
  const changed = await request('/api/auth/recover', null, 'POST', { username: rotated.username, recoveryCode: rotated.recoveryCode, password: 'Another-new-password-123' });
  check(changed.status === 200, 'recovery completes during an earlier recovery-code rotation');
  release(rotated.password);
  check((await inFlight).status === 409, 'stale recovery-code rotation is rejected');
  const saved = (await pool.query('SELECT recovery_hash FROM letchat_local_accounts WHERE user_id=$1', [rotated.id])).rows[0];
  check(saved.recovery_hash === recoveryHash(changed.json.recoveryCode), 'stale rotation cannot overwrite the new recovery code');
  const signedIn = await login({ ...rotated, password: 'Another-new-password-123' });
  check((await request('/api/account/recovery-code', signedIn.json.token, 'POST', { password: 'Another-new-password-123' })).status === 200, 'normal recovery-code rotation still works');

  // Restart only the isolated child to reset the per-IP login limit before the load case.
  await stop(); await start(connectionString);
  const loaded = await seed('loaded');
  let resolveBusy;
  const firstBusy = new Promise(resolve => { resolveBusy = resolve; });
  const burst = Array.from({ length: 11 }, () => login(loaded).then(r => { if (r.status === 503) resolveBusy(r); return r; }));
  let deadline;
  try {
    const overload = await Promise.race([firstBusy, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Overflow was not rejected promptly')), 4000); })]);
    check(overload.headers.get('retry-after') === '2' && /Réessayez/.test(overload.json.error), 'overflow returns a useful 503 and Retry-After header');
    check((await request('/api/health')).status === 200, 'health endpoint responds with password work held and queued');
    const message = await request('/api/private', sender.token, 'POST', { recipientId: recipient.id, body: 'Le tchat reste disponible pendant les connexions.' });
    check(message.status === 201, 'private message is accepted while password slots are occupied');
    const messages = await request(`/api/private/${sender.id}`, recipient.token);
    check(messages.status === 200 && messages.json.some(m => m.id === message.json.id), 'recipient can read the message before password work is released');
  } finally { clearTimeout(deadline); release(loaded.password); }
  const responses = await Promise.all(burst);
  check(responses.filter(r => r.status === 200).length === 10 && responses.filter(r => r.status === 503).length === 1, 'two active plus eight queued logins succeed; the eleventh is refused');
  check((await login(loaded)).status === 200, 'password slots are available again after the burst');
  check(!logs.includes('Erreur serveur'), 'no unexpected server error during password scenarios');
  console.log(`\n${checks} password HTTP checks passed on isolated PGlite; no production account was used.`);
} catch (error) {
  console.error(logs); console.error(error.stack || error); process.exitCode = 1;
} finally {
  await stop(); await pool?.end(); await bridge.stop().catch(() => {}); await wait(100); await db.close();
}
