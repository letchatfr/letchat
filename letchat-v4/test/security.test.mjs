import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { validateMedia, serveMedia } from "../lib/media.js";
import { CallRegistry } from "../lib/calls.js";
import { newRecoveryCode, recoveryHash } from "../lib/accounts.js";

function setup() {
  const sockets = new Map(["a", "b", "c"].map(id => [id, { id, room: "cafe", user: { id, name: id, email: "private@example.invalid", profile: { city: "secret", location_visible: false } }, events: [], emit(event, data) { this.events.push({ event, data }); } }]));
  const registry = new CallRegistry({ sockets, permitted: async () => true });
  const send = (from, to, type, callId, extra = {}) => registry.handle(sockets.get(from), { target: to, data: { type, callId, ...extra } });
  return { sockets, registry, send };
}
test("third participant cannot join or send offers, before or after acceptance", async () => {
  const { sockets, registry, send } = setup(), id = randomUUID();
  await send("a", "b", "invite", id);
  await send("c", "a", "join", id);
  await send("c", "a", "offer", id, { sdp: { type: "offer", sdp: "v=0" } });
  assert.equal(sockets.get("a").events.length, 0);
  await send("b", "a", "join", id);
  await send("c", "a", "join", id);
  assert.equal(sockets.get("a").events.length, 1);
  registry.end("a");
});
test("private fields are never relayed; offers need explicit acceptance", async () => {
  const { sockets, registry, send } = setup(), id = randomUUID();
  await send("a", "b", "invite", id);
  assert.deepEqual(sockets.get("b").events[0].data.user, { id: "a", name: "a", photo: null });
  await send("a", "b", "offer", id, { sdp: { type: "offer", sdp: "v=0" } });
  assert.equal(sockets.get("b").events.length, 1);
  await send("b", "a", "join", id);
  await send("a", "b", "offer", id, { sdp: { type: "offer", sdp: "v=0" } });
  assert.equal(sockets.get("b").events.at(-1).data.data.type, "offer");
  registry.end("a");
});
test("declined, expired, wrong-room and blocked calls cannot relay media", async () => {
  const { sockets, registry, send } = setup(), id = randomUUID();
  await send("a", "b", "invite", id); await send("b", "a", "decline", id);
  await send("b", "a", "join", id); assert.equal(registry.calls.size, 0);
  const expired = randomUUID(); await send("a", "b", "invite", expired);
  registry.now = () => Date.now() + 31000;
  await send("b", "a", "join", expired); assert.equal(registry.calls.size, 0);
  sockets.get("b").room = "other";
  await send("a", "b", "invite", randomUUID()); assert.equal(registry.calls.size, 0);
  sockets.get("b").room = "cafe"; registry.permitted = async () => false;
  await send("a", "b", "invite", randomUUID()); assert.equal(registry.calls.size, 0);
});
test("a block ends an active call and invalidates its ID", async () => {
  const { registry, send } = setup(), id = randomUUID();
  await send("a", "b", "invite", id); await send("b", "a", "join", id);
  registry.endBetween("a", "b"); assert.equal(registry.bySocket.size, 0);
  await send("a", "b", "ice", id, { candidate: { candidate: "candidate:1" } });
  assert.equal(registry.calls.size, 0);
});
test("parallel invitations cannot reserve the same participant twice", async () => {
  const { registry, send } = setup();
  await Promise.all([send("a", "b", "invite", randomUUID()), send("c", "b", "invite", randomUUID())]);
  assert.equal(registry.calls.size, 1); registry.end("b");
});
test("SVG, HTML with image MIME, invalid base64 and wrong MIME are rejected", async () => {
  for (const [body, mime] of [["<svg onload='alert(1)'></svg>", "image/svg+xml"], ["<html>test</html>", "image/png"]])
    await assert.rejects(validateMedia(Buffer.from(body).toString("base64"), mime), { status: 415 });
  await assert.rejects(validateMedia("not-base64!", "image/png"), { status: 415 });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(validateMedia(png.toString("base64"), "image/jpeg"), { status: 415 });
});
test("valid image is decoded and re-encoded without appended active content", async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const { media, mediaType } = await validateMedia(Buffer.concat([png, Buffer.from("<script>secret-marker</script>")]).toString("base64"), "image/png");
  assert.equal(mediaType, "image/webp"); assert.equal((await sharp(media).metadata()).width, 4);
  assert.equal(media.includes(Buffer.from("secret-marker")), false);
});
test("historical SVG media is blocked and valid media receives sandbox headers", () => {
  const res = { status(code) { this.code = code; return this; }, json(value) { return value; }, type() { return this; }, set(headers) { this.headers = headers; return this; }, send() { return this; } };
  serveMedia(res, Buffer.from("<svg/>"), "image/svg+xml"); assert.equal(res.code, 415);
  serveMedia(res, Buffer.from("x"), "image/webp"); assert.match(res.headers["Content-Security-Policy"], /sandbox/);
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});
test("recovery codes have 192 bits and normalize spaces/case", () => {
  const code = newRecoveryCode(); assert.match(code, /^[A-F0-9]{6}(?:-[A-F0-9]{6}){7}$/);
  assert.equal(recoveryHash(code), recoveryHash(code.toLowerCase().replaceAll("-", " ")));
  assert.notEqual(recoveryHash(code), recoveryHash(newRecoveryCode()));
});
