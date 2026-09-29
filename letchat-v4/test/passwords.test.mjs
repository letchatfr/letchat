import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { createPasswordService, passwordDigest, matchesPassword } from '../lib/passwords.js';

const salt = '0123456789abcdef0123456789abcdef';
const key = Buffer.alloc(64, 42);

test('asynchronous hashes preserve historical passwords byte for byte', async () => {
  for (const password of ['Mot-de-passe-123', 'Été à Montréal 🔐', ' espaces conservés ', 'x'.repeat(200)]) {
    const legacy = scryptSync(password, salt, 64).toString('hex');
    assert.equal(await passwordDigest(password, salt), legacy);
    assert.equal(await matchesPassword(password, { password_hash: legacy, password_salt: salt }), true);
    assert.equal(await matchesPassword(password + '!', { password_hash: legacy, password_salt: salt }), false);
  }
});

test('malformed credentials are rejected without scheduling expensive work', async () => {
  let calls = 0;
  const service = createPasswordService({ deriveKey: async () => { calls++; return key; } });
  for (const row of [undefined, {}, { password_hash: 'bad', password_salt: salt },
    { password_hash: key.toString('hex'), password_salt: '' },
    { password_hash: key.toString('hex'), password_salt: 's'.repeat(257) }]) {
    assert.equal(await service.matches('password', row), false);
  }
  assert.equal(await service.matches('x'.repeat(201), { password_hash: key.toString('hex'), password_salt: salt }), false);
  await assert.rejects(service.digest('x'.repeat(201), salt), TypeError);
  assert.equal(calls, 0);
});

test('one FIFO queue bounds hashing and verification together and reports overflow', async () => {
  const starts = [], pending = [];
  let active = 0, peak = 0;
  const service = createPasswordService({ maxActive: 2, maxQueued: 2, deriveKey: async password => {
    active++; peak = Math.max(peak, active); starts.push(password);
    await new Promise(resolve => pending.push(resolve));
    active--; return key;
  } });
  const tasks = [service.digest('first', salt), service.matches('second', { password_hash: key.toString('hex'), password_salt: salt }),
    service.digest('third', salt), service.digest('fourth', salt)];
  await assert.rejects(service.digest('overflow', salt), { status: 503, code: 'AUTH_BUSY', expose: true });
  assert.deepEqual(starts, ['first', 'second']);
  pending.shift()(); await turn();
  assert.deepEqual(starts, ['first', 'second', 'third']);
  pending.shift()(); await turn();
  assert.deepEqual(starts, ['first', 'second', 'third', 'fourth']);
  pending.splice(0).forEach(resolve => resolve());
  const result = await Promise.all(tasks);
  assert.equal(result[1], true); assert.equal(peak, 2); assert.equal(active, 0);
});

test('expired queue entries never execute and their places can be reused', async () => {
  let release, calls = 0;
  const service = createPasswordService({ maxActive: 1, maxQueued: 1, maxWaitMs: 25, deriveKey: async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return key;
  } });
  const first = service.digest('first', salt);
  await assert.rejects(service.digest('expires', salt), { status: 503, code: 'AUTH_BUSY' });
  const replacement = service.digest('replacement', salt);
  release(); await Promise.all([first, replacement]);
  assert.equal(calls, 2);
  assert.equal(await service.digest('next', salt), key.toString('hex'));
});

test('a failed derivation releases its place for the next request', async () => {
  let rejectFirst, calls = 0;
  const service = createPasswordService({ maxActive: 1, deriveKey: async () => {
    if (++calls === 1) await new Promise((_, reject) => { rejectFirst = reject; });
    return key;
  } });
  const rejected = assert.rejects(service.digest('first', salt), /injected failure/);
  const next = service.digest('second', salt);
  await turn(); rejectFirst(new Error('injected failure'));
  await rejected; assert.equal(await next, key.toString('hex'));
});

test('native password calculations leave the event loop available', async () => {
  const service = createPasswordService({ maxActive: 1 });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    await Promise.all(Array.from({ length: 4 }, (_, i) => service.digest('real-password-' + i, salt)));
    assert.ok(ticks > 0, 'timers must run while native hashes are being calculated');
  } finally { clearInterval(timer); }
});

test('a zero-length waiting queue permits active work and refuses overflow', async () => {
  let release;
  const service = createPasswordService({ maxActive: 1, maxQueued: 0, deriveKey: () => new Promise(resolve => { release = () => resolve(key); }) });
  const first = service.digest('first', salt);
  await assert.rejects(service.digest('overflow', salt), { code: 'AUTH_BUSY' });
  release(); await first;
});
