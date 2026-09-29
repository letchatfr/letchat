// Test-only preload: hold completed native hashes to reproduce overlapping HTTP requests.
// Production never imports this module. An IPC parent and NODE_ENV=test are mandatory.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.NODE_ENV !== 'test' || !process.send) throw new Error('Password pause requires an isolated test child');
const native = crypto.scrypt;
const paused = new Map(), released = new Set();
process.on('message', message => {
  if (message?.type !== 'release-password') return;
  released.add(message.password);
  const callbacks = paused.get(message.password) || [];
  paused.delete(message.password);
  callbacks.forEach(callback => callback());
});
crypto.scrypt = function(password, ...args) {
  const callback = args.pop();
  return native.call(this, password, ...args, (error, value) => {
    if (!String(password).startsWith('TEST-PAUSE-') || released.has(password)) return callback(error, value);
    const callbacks = paused.get(password) || [];
    callbacks.push(() => callback(error, value)); paused.set(password, callbacks);
    process.send({ type: 'password-paused', password });
  });
};
syncBuiltinESMExports();
