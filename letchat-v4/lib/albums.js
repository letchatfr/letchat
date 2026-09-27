import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { validateMedia, serveMedia } from "./media.js";

const MAX_PHOTOS = 36;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };

export async function installAlbums({ app, pool, base, write, wrap, blocked, transaction, rateLimitAction, hasPremiumAccess }) {
  await pool.query(`CREATE TABLE IF NOT EXISTS letchat_album_photos (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    image_data BYTEA NOT NULL, thumbnail_data BYTEA NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'image/webp', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ); CREATE INDEX IF NOT EXISTS idx_album_owner ON letchat_album_photos(user_id,created_at);`);

  async function access(owner, viewer) {
    if (owner !== viewer && await blocked(owner, viewer)) fail("Album indisponible", 403);
    if (!(await pool.query("SELECT 1 FROM profiles WHERE user_id=$1", [owner])).rowCount) fail("Membre introuvable", 404);
  }
  // Albums are visible to members independently of friendship and Premium status.
  app.get("/api/social/albums/:owner", ...base, wrap(async (req, res) => {
    await access(req.params.owner, req.user.id);
    const limit = await hasPremiumAccess(req.params.owner) ? 36 : 12;
    const { rows } = await pool.query("SELECT id,created_at FROM letchat_album_photos WHERE user_id=$1 ORDER BY created_at,id LIMIT $2", [req.params.owner, MAX_PHOTOS]);
    res.set("Cache-Control", "private, no-store").json({ photos: rows, limit });
  }));
  app.get("/api/social/albums/:owner/:photo/:size", ...base, wrap(async (req, res) => {
    if (!["image", "thumbnail"].includes(req.params.size)) fail("Photo introuvable", 404);
    await access(req.params.owner, req.user.id);
    const column = req.params.size === "thumbnail" ? "thumbnail_data" : "image_data";
    const row = (await pool.query(`SELECT ${column} AS data,media_type FROM letchat_album_photos WHERE id=$1 AND user_id=$2`, [req.params.photo, req.params.owner])).rows[0];
    if (!row) fail("Photo introuvable", 404);
    serveMedia(res, row.data, row.media_type);
  }));
  app.post("/api/social/albums", ...write, rateLimitAction("album-upload", 48, 60000), wrap(async (req, res) => {
    const { media, mediaType } = await validateMedia(req.body.mediaBase64, req.body.mediaType);
    if (!media || !mediaType.startsWith("image/")) fail("Choisissez une photo JPG, PNG, WebP, GIF ou AVIF", 415);
    // Store a static, metadata-free image and a small thumbnail for the profile grid.
    const image = await sharp(media).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    if (image.length > 2e6) fail("Cette photo est trop volumineuse. Choisissez une image plus petite.", 413);
    const thumbnail = await sharp(image).resize({ width: 400, height: 400, fit: "cover", withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    const photo = await transaction(async db => {
      // Serialize uploads for each owner so simultaneous requests cannot exceed the cap.
      if (!(await db.query("SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE", [req.user.id])).rowCount) fail("Profil introuvable", 404);
      const count = Number((await db.query("SELECT count(*) AS count FROM letchat_album_photos WHERE user_id=$1", [req.user.id])).rows[0].count);
      const limit = await hasPremiumAccess(req.user.id, db) ? 36 : 12;
      if (count >= limit) fail(`La limite de votre formule est de ${limit} photos. Vos photos existantes restent conservées. Supprimez-en pour libérer une place.`, 409);
      return (await db.query(`INSERT INTO letchat_album_photos(id,user_id,image_data,thumbnail_data)
        VALUES($1,$2,$3,$4) RETURNING id,created_at`, [randomUUID(), req.user.id, image, thumbnail])).rows[0];
    });
    res.status(201).json(photo);
  }));
  app.delete("/api/social/albums/:photo", ...write, wrap(async (req, res) => {
    const deleted = await pool.query("DELETE FROM letchat_album_photos WHERE id=$1 AND user_id=$2", [req.params.photo, req.user.id]);
    if (!deleted.rowCount) fail("Photo introuvable", 404);
    res.json({ ok: true });
  }));
}
