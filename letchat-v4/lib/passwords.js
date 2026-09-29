import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const nativeScrypt = promisify(scrypt);
// Same parameters, UTF-8 salt and 64-byte format as historical scryptSync hashes.
const parameters = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const derive = (password, salt) => nativeScrypt(password, salt, 64, parameters);
const busy = () => Object.assign(new Error('Plusieurs connexions sont en cours. Réessayez dans quelques secondes.'), { status: 503, expose: true, code: 'AUTH_BUSY' });

export function createPasswordService({ deriveKey = derive, maxActive = 2, maxQueued = 8, maxWaitMs = 5000 } = {}) {
  if (!Number.isInteger(maxActive) || maxActive < 1 || !Number.isInteger(maxQueued) || maxQueued < 0 || !Number.isFinite(maxWaitMs) || maxWaitMs < 1)
    throw new TypeError('Invalid password queue limits');
  let active = 0;
  const queue = [];
  function acquire() {
    if (active < maxActive) { active++; return Promise.resolve(); }
    if (queue.length >= maxQueued) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const job = { resolve, timer: null };
      job.timer = setTimeout(() => {
        const index = queue.indexOf(job);
        if (index !== -1) { queue.splice(index, 1); reject(busy()); }
      }, maxWaitMs);
      queue.push(job);
    });
  }
  function release() {
    const job = queue.shift();
    if (job) { clearTimeout(job.timer); job.resolve(); }
    else active--;
  }
  async function key(password, salt) {
    if (typeof password !== 'string' || password.length > 200 || typeof salt !== 'string' || !salt.length || salt.length > 256)
      throw new TypeError('Invalid password input');
    await acquire();
    try { return await deriveKey(password, salt); }
    finally { release(); }
  }
  return {
    async digest(password, salt) { return (await key(password, salt)).toString('hex'); },
    async matches(password, row) {
      if (typeof password !== 'string' || password.length > 200 || !/^[a-f0-9]{128}$/i.test(row?.password_hash || '') || typeof row?.password_salt !== 'string' || !row.password_salt || row.password_salt.length > 256) return false;
      const supplied = await key(password, row.password_salt), expected = Buffer.from(row.password_hash, 'hex');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    }
  };
}
// Shared by registration, login and both recovery endpoints in this process.
const passwords = createPasswordService();
export const passwordDigest = passwords.digest;
export const matchesPassword = passwords.matches;
