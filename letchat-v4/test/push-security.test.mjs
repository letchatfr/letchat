import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { validatePushSubscription, isPublicPushAddress, createPushLookup, sendValidatedPush, pushAgent } from "../lib/push-security.js";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
const subscription = endpoint => ({ endpoint, keys });

test("browser push endpoints retain their token, path and query", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/wp/browser-token", "https://fcm.googleapis.com/fcm/send/legacy-token",
    "https://updates.push.services.mozilla.com/wpush/v2/browser-token",
    "https://web.push.apple.com/Q/browser-token", "https://eu.web.push.apple.com/Q/token",
    "https://wns2-sg2p.notify.windows.com/w/?token=test-token"
  ]) assert.equal(validatePushSubscription(subscription(endpoint)).endpoint, endpoint);
});

test("private addresses, arbitrary hosts, lookalikes and unusual URLs fail before sending", async () => {
  let sends = 0;
  const transport = { sendNotification() { sends++; } };
  for (const endpoint of [
    "https://127.0.0.1/", "https://[::1]/x", "https://2130706433/x", "https://169.254.169.254/x",
    "https://10.0.0.1/x", "https://example.invalid/x", "https://fcm.googleapis.com.evil.invalid/wp/t",
    "https://evilpush.apple.com/x", "https://push.apple.com.evil.invalid/x", "https://notify.windows.com.evil.invalid/w/",
    "http://fcm.googleapis.com/wp/t", "https://fcm.googleapis.com:8443/wp/t",
    "https://name:password@fcm.googleapis.com/wp/t", "https://fcm.googleapis.com/wp/t#fragment",
    "https://fcm.googleapis.com/", "https://fcm.googleapis.com/\\evil", "https://fcm.googleapis.com/wp/a b"
  ]) await assert.rejects(sendValidatedPush(transport, subscription(endpoint), {}), { status: 400 });
  assert.equal(sends, 0);
});

test("encryption keys must be canonical base64url and a real uncompressed P-256 point", () => {
  for (const badKeys of [null, {}, { ...keys, auth: "wrong" }, { ...keys, auth: "*".repeat(22) },
    { ...keys, p256dh: randomBytes(65).toString("base64url") },
    { ...keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url") }
  ]) assert.throws(() => validatePushSubscription({ endpoint: "https://fcm.googleapis.com/wp/t", keys: badKeys }), { status: 400 });
});

test("outgoing DNS rejects local, reserved and mapped addresses", () => {
  for (const ip of ["0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.1.2", "192.168.1.1", "100.64.0.1",
    "169.254.169.254", "198.18.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "invalid"])
    assert.equal(isPublicPushAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001::1"])
    assert.equal(isPublicPushAddress(ip), true, ip);
});

test("DNS addresses are validated at connection time for both Node lookup modes", async () => {
  const call = (addresses, options) => new Promise((resolve, reject) => {
    const lookup = createPushLookup((_host, _options, done) => done(null, addresses));
    lookup("fcm.googleapis.com", options, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  const publicAddress = { address: "8.8.8.8", family: 4 };
  assert.deepEqual(await call([publicAddress], {}), publicAddress);
  assert.deepEqual((await call([publicAddress], { all: true })).address, [publicAddress]);
  await assert.rejects(call([publicAddress, { address: "127.0.0.1", family: 4 }], { all: true }), { code: "EACCES" });
  await assert.rejects(call([], {}), { code: "EACCES" });
});

test("validated sends use the guarded HTTPS agent and a finite timeout", async () => {
  let sent;
  await sendValidatedPush({ async sendNotification(...args) { sent = args; } }, subscription("https://web.push.apple.com/Q/token"), { title: "Test" });
  assert.equal(sent[2].agent, pushAgent);
  assert.equal(sent[2].timeout, 5000);
  assert.deepEqual(JSON.parse(sent[1]), { title: "Test" });
});
