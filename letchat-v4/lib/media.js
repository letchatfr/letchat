import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertibleMedia, transcodeMedia, transcodeBitmap, withMediaWorkspace } from "./media-transcode.js";

const execute = promisify(execFile);
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/tiff", "image/heic", "image/heif"]);

const allowed = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/wav", "audio/ogg", "audio/opus", "audio/mp4", "audio/webm"]);
function invalid(message = "Format non pris en charge ou fichier endommagé. Choisissez une photo, une vidéo ou un fichier audio.", status = 415) {
  return Object.assign(new Error(message), { status, expose: true });
}
export async function validateMedia(base64, declaredType = "") {
  if (!base64) return { media: null, mediaType: null };
  if (typeof base64 !== "string" || base64.length > 10666668) throw invalid("Fichier trop volumineux (8 Mo maximum)", 413);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw invalid();
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > 8e6) throw invalid("Fichier vide ou trop volumineux (8 Mo maximum)", 413);
  let detected;
  try { detected = await fileTypeFromBuffer(buffer); } catch { throw invalid(); }
  // Browser MIME and filename are hints only; decode the bytes to establish the real format.
  if (!detected) throw invalid();
  if (detected.mime === "image/bmp") return transcodeBitmap(buffer);
  if (imageTypes.has(detected.mime)) {
    try {
      if (["image/heic", "image/heif"].includes(detected.mime)) return await withMediaWorkspace(async directory => {
        const input = join(directory, "input.heic"), output = join(directory, "output.webp");
        await writeFile(input, buffer, { mode: 0o600 });
        await execute(process.execPath, ["--max-old-space-size=192", fileURLToPath(new URL("./heic-worker.js", import.meta.url)), input, output],
          { timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144 });
        return { media: await readFile(output), mediaType: "image/webp" };
      });
      // Decoding/re-encoding strips metadata and any appended active document.
      const media = await sharp(buffer, { animated: true, limitInputPixels: 40e6, failOn: "warning" })
        .rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 }).toBuffer();
      if (media.length > 8e6) throw invalid("Image trop volumineuse", 413);
      return { media, mediaType: "image/webp" };
    } catch (error) { if (error.expose) throw error; throw invalid("Image endommagée ou dimensions trop grandes"); }
  }
  if (convertibleMedia(detected.ext)) return transcodeMedia(buffer, detected.ext);
  throw invalid();
}
export function serveMedia(res, media, type) {
  // Also protects historical uploads made before the allowlist existed.
  if (!allowed.has(type)) return res.status(415).json({ error: "Ce format de média n’est plus autorisé" });
  return res.type(type).set({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; media-src 'self' blob:; img-src 'self' blob:; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer"
  }).send(media);
}
