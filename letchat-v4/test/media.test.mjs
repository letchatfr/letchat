import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";
import { validateMedia } from "../lib/media.js";
import { withMediaWorkspace } from "../lib/media-transcode.js";

const directory = await mkdtemp(join(tmpdir(), "letchat-formats-test-"));
test.after(() => rm(directory, { recursive: true, force: true }));
function run(args) { return execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { timeout: 20000, maxBuffer: 1048576 }); }
async function fixture(name, options, video = true) {
  const path = join(directory, name);
  run([...(video ? ["-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=0.3"] : []),
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-threads", "1", ...options, path]);
  return readFile(path);
}
async function checkOutput(result, type) {
  assert.equal(result.mediaType, type);
  const path = join(directory, type.startsWith("video") ? "checked.mp4" : "checked.mp3");
  await writeFile(path, result.media);
  // Fully decode the actual output. A valid container header is not sufficient.
  run(["-i", path, "-f", "null", "-"]);
  if (type.startsWith("video")) {
    let log = "";
    try { execFileSync(ffmpeg, ["-hide_banner", "-i", path], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (error) { log = String(error.stderr); }
    assert.match(log, /Video: h264/); assert.match(log, /yuv420p/); assert.match(log, /Audio: aac/);
    assert.ok(result.media.indexOf(Buffer.from("moov")) < result.media.indexOf(Buffer.from("mdat")), "fast-start MP4");
  }
}
for (const [name, options] of [
  ["iphone.mov", ["-c:v", "libx265", "-x265-params", "pools=none:frame-threads=1:log-level=error", "-tag:v", "hvc1", "-c:a", "aac"]],
  ["movie.mkv", ["-c:v", "ffv1", "-c:a", "flac"]],
  ["movie.avi", ["-c:v", "mpeg4", "-c:a", "pcm_s16le"]],
  ["movie.webm", ["-c:v", "libvpx-vp9", "-c:a", "libopus"]],
  ["movie.wmv", ["-c:v", "wmv2", "-c:a", "wmav2"]],
  ["movie.flv", ["-c:v", "flv", "-c:a", "libmp3lame"]],
]) test(`${name}: real video becomes decodable H.264/AAC even with generic browser MIME`, async () => {
  const input = await fixture(name, options);
  await checkOutput(await validateMedia(input.toString("base64"), "application/octet-stream"), "video/mp4");
});
for (const [name, options] of [
  ["sound.flac", ["-c:a", "flac"]], ["sound.wav", ["-c:a", "pcm_s16le"]],
  ["voice.webm", ["-c:a", "libopus"]], ["voice.ogg", ["-c:a", "libopus"]],
  ["sound.m4a", ["-c:a", "aac"]], ["sound.mp3", ["-c:a", "libmp3lame"]],
  ["sound.aac", ["-c:a", "aac"]], ["sound.aiff", ["-c:a", "pcm_s16be"]],
]) test(`${name}: real audio becomes decodable MP3 with no declared MIME`, async () => {
  await checkOutput(await validateMedia((await fixture(name, options, false)).toString("base64"), ""), "audio/mpeg");
});
test("TIFF and images with generic MIME become safe WebP", async () => {
  const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: "red" } }).tiff().toBuffer();
  const converted = await validateMedia(bytes.toString("base64"), "application/octet-stream");
  assert.equal(converted.mediaType, "image/webp"); assert.equal((await sharp(converted.media).metadata()).height, 30);
});
test("BMP becomes decodable WebP", async () => {
  const path = join(directory, "bitmap.bmp");
  run(["-f", "lavfi", "-i", "color=c=red:s=20x30", "-frames:v", "1", path]);
  const converted = await validateMedia((await readFile(path)).toString("base64"));
  assert.equal(converted.mediaType, "image/webp"); assert.equal((await sharp(converted.media).metadata()).height, 30);
});
test("active documents, damaged containers and oversize input are rejected", async () => {
  for (const content of ["<svg><script>alert(1)</script></svg>", "#EXTM3U\nhttp://localhost/secret", "%PDF-1.4"])
    await assert.rejects(validateMedia(Buffer.from(content).toString("base64"), "video/mp4"), { status: 415 });
  await assert.rejects(validateMedia(Buffer.from("000000186674797069736f6d0000000069736f6d", "hex").toString("base64")), { status: 415 });
  await assert.rejects(validateMedia(Buffer.alloc(8000001).toString("base64")), { status: 413 });
});
test("busy conversion is retryable; temporary files and capacity are released after errors", async () => {
  await withMediaWorkspace(async () => {
    await assert.rejects(withMediaWorkspace(async () => {}), { status: 503 });
  });
  let temporary;
  await assert.rejects(withMediaWorkspace(async path => { temporary = path; throw new Error("test failure"); }));
  await assert.rejects(readFile(join(temporary, "input")), { code: "ENOENT" });
  await withMediaWorkspace(async () => {});
});
