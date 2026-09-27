import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";

const allowed = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/wav", "audio/ogg", "audio/opus", "audio/mp4", "audio/webm"]);
function invalid(message = "Format non accepté. Choisissez une photo, une vidéo MP4/WebM ou un fichier audio.", status = 415) {
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
  if (detected?.mime === "audio/x-m4a") detected.mime = "audio/mp4";
  if (!detected || !allowed.has(detected.mime)) throw invalid();
  const declared = String(declaredType).split(";")[0].toLowerCase().replace(/^audio\/x-m4a$/, "audio/mp4");
  // WebM/MP4 containers may carry audio only (browser voice recordings).
  const audioContainer = declared === "audio/webm" && detected.mime === "video/webm"
    || declared === "audio/mp4" && detected.mime === "video/mp4";
  if (declared && declared !== detected.mime && !audioContainer
    && !(declared === "audio/ogg" && detected.mime === "audio/opus")
    && !(declared === "audio/x-wav" && detected.mime === "audio/wav")) throw invalid();
  if (detected.mime.startsWith("image/")) {
    try {
      // Decoding/re-encoding strips metadata and any appended active document.
      const media = await sharp(buffer, { animated: true, limitInputPixels: 40e6, failOn: "warning" })
        .rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 }).toBuffer();
      if (media.length > 8e6) throw invalid("Image trop volumineuse", 413);
      return { media, mediaType: "image/webp" };
    } catch (error) { if (error.expose) throw error; throw invalid("Image endommagée ou dimensions trop grandes"); }
  }
  return { media: buffer, mediaType: audioContainer ? declared : detected.mime };
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
