import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";

const execute = promisify(execFile);
const formats = new Map([
  ["mp4", "mov"], ["mov", "mov"], ["m4a", "mov"], ["m4v", "mov"], ["3gp", "mov"], ["3g2", "mov"],
  ["webm", "matroska"], ["mkv", "matroska"], ["mka", "matroska"], ["avi", "avi"],
  ["wmv", "asf"], ["asf", "asf"], ["wma", "asf"], ["mpg", "mpeg"], ["mpeg", "mpeg"],
  ["mts", "mpegts"], ["m2ts", "mpegts"], ["flv", "flv"], ["ogg", "ogg"], ["ogv", "ogg"],
  ["oga", "ogg"], ["opus", "ogg"], ["mp3", "mp3"], ["wav", "wav"], ["flac", "flac"],
  ["aac", "aac"], ["amr", "amr"], ["aif", "aiff"], ["aiff", "aiff"], ["ac3", "ac3"]
]);
export const convertibleMedia = ext => formats.has(ext);
const failure = (message, status = 415) => Object.assign(new Error(message), { status, expose: true });
let active = false;

// One bounded conversion at a time keeps the small web instance responsive.
export async function withMediaWorkspace(work) {
  if (active) throw failure("Un média est en cours de préparation. Réessayez dans quelques instants.", 503);
  active = true;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), "letchat-media-"));
    return await work(directory);
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { active = false; }
  }
}

export async function transcodeMedia(buffer, ext) {
  if (!formats.has(ext)) throw failure("Ce format audio ou vidéo n’est pas pris en charge.");
  return withMediaWorkspace(async directory => {
    const input = join(directory, "input");
    await writeFile(input, buffer, { mode: 0o600 });
    // Force a detected container: playlists, network and arbitrary file references are not accepted.
    const source = ["-hide_banner", "-nostdin", "-max_alloc", "67108864", "-protocol_whitelist", "file",
      "-f", formats.get(ext), "-threads", "1", "-i", input];
    let probe;
    try { await execute(ffmpeg, source, { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 262144 }); }
    catch (error) {
      if (error.code !== 1 || !error.stderr?.includes("At least one output file must be specified"))
        throw failure("Fichier audio ou vidéo endommagé ou codec non pris en charge.");
      probe = error.stderr;
    }
    const video = probe?.split("\n").some(line => /Stream #.*Video:/.test(line) && !line.includes("attached pic"));
    const audio = /Stream #.*Audio:/.test(probe || "");
    if (!video && !audio) throw failure("Ce fichier ne contient aucune piste audio ou vidéo lisible.");
    const dimensions = [...(probe || "").matchAll(/Video:.*?\b(\d{2,6})x(\d{2,6})\b/g)];
    if (dimensions.some(m => Number(m[1]) * Number(m[2]) > 40e6)) throw failure("Dimensions de la vidéo trop grandes.");
    const output = join(directory, video ? "output.mp4" : "output.mp3");
    const options = video
      ? ["-map", "0:V:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-r", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"]
      : ["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "128k"];
    try {
      await execute(ffmpeg, [...source, "-y", "-filter_threads", "1", "-threads", "1", ...options,
        "-ac", "2", "-ar", "44100", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
        "-fs", "9000000", output], { timeout: 60000, killSignal: "SIGKILL", maxBuffer: 1048576 });
    } catch (error) {
      if (error.killed) throw failure("La préparation a pris trop de temps. Essayez un média plus court.", 422);
      throw failure("Ce fichier est endommagé ou son codec ne peut pas être converti.");
    }
    const size = (await stat(output)).size;
    // The ffmpeg stop limit is ABOVE our storage limit: never accept a silently truncated output.
    if (!size || size > 8e6) throw failure("Le média converti dépasse 8 Mo. Essayez un fichier plus court.", 413);
    return { media: await readFile(output), mediaType: video ? "video/mp4" : "audio/mpeg" };
  });
}

export async function transcodeBitmap(buffer) {
  // Standard Windows/OS2 BMP headers provide dimensions before any allocation by a decoder.
  if (buffer.length < 30) throw failure("Image BMP endommagée.");
  const oldHeader = buffer.readUInt32LE(14) === 12;
  const width = oldHeader ? buffer.readUInt16LE(18) : Math.abs(buffer.readInt32LE(18));
  const height = oldHeader ? buffer.readUInt16LE(20) : Math.abs(buffer.readInt32LE(22));
  if (!width || !height || width * height > 40e6) throw failure("Dimensions de l’image trop grandes.");
  return withMediaWorkspace(async directory => {
    const input = join(directory, "input.bmp"), output = join(directory, "output.webp");
    await writeFile(input, buffer, { mode: 0o600 });
    try {
      await execute(ffmpeg, ["-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-f", "bmp_pipe", "-threads", "1",
        "-i", input, "-filter_threads", "1", "-threads", "1", "-frames:v", "1", "-c:v", "libwebp", "-quality", "85",
        "-vf", "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", output],
        { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 262144 });
    } catch { throw failure("Image BMP endommagée."); }
    if ((await stat(output)).size > 8e6) throw failure("Image trop volumineuse.", 413);
    return { media: await readFile(output), mediaType: "image/webp" };
  });
}
