import { randomUUID } from "node:crypto";
import { validateMedia, serveMedia } from "./media.js";
import { installLive } from "./social-live.js";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };
const clean = (s, max) => String(s || "").trim().slice(0, max);
export function playMove(game, userId, move) {
  if (game.status !== "active" || game.turn_id !== userId) fail("Ce n’est pas votre tour", 409);
  const board = [...game.board], token = userId === game.creator_id ? 1 : 2;
  const cols = game.kind === "connect4" ? 7 : 3, rows = game.kind === "connect4" ? 6 : 3;
  const target = Number(move);
  if (!Number.isInteger(target) || target < 0 || target >= (game.kind === "connect4" ? 7 : 9)) fail("Case incorrecte");
  let cell = target;
  if (game.kind === "connect4") {
    cell = -1;
    for (let row = rows - 1; row >= 0; row--) if (!board[row * cols + target]) { cell = row * cols + target; break; }
  }
  if (cell < 0 || board[cell]) fail("Cette case ou colonne est pleine", 409);
  board[cell] = token;
  const run = game.kind === "connect4" ? 4 : 3;
  let won = false;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      if (Array.from({ length: run }, (_, k) => [x + k * dx, y + k * dy])
        .every(([xx, yy]) => xx >= 0 && xx < cols && yy >= 0 && yy < rows && board[yy * cols + xx] === token)) won = true;
    }
  }
  const status = won ? "won" : board.every(Boolean) ? "draw" : "active";
  return { board, status, winner_id: won ? userId : null, turn_id: status === "active" ? (userId === game.creator_id ? game.opponent_id : game.creator_id) : null };
}

export async function installSocial({ app, pool, io, auth, requireAdult, requireRules, rateLimitAction, hasPremiumAccess, roomCatalog, socketSessionValid }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS letchat_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS letchat_group_members (
      group_id TEXT NOT NULL REFERENCES letchat_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted')), joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(group_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON letchat_group_members(user_id);
    CREATE TABLE IF NOT EXISTS letchat_group_messages (
      id BIGSERIAL PRIMARY KEY, group_id TEXT NOT NULL REFERENCES letchat_groups(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE, sender_name TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', media_data BYTEA, media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '48 hours')
    );
    CREATE INDEX IF NOT EXISTS idx_group_messages ON letchat_group_messages(group_id,created_at);
    CREATE TABLE IF NOT EXISTS letchat_games (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('connect4','tictactoe')),
      creator_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      opponent_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', board JSONB NOT NULL, turn_id TEXT, winner_id TEXT,
      version INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '48 hours')
    );
    CREATE TABLE IF NOT EXISTS letchat_profile_extras (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      character TEXT NOT NULL DEFAULT '', likes TEXT NOT NULL DEFAULT '', looking_for TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','friends')),
      cover_data BYTEA, cover_type TEXT, voice_data BYTEA, voice_type TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const base = [auth, requireAdult];
  const write = [...base, requireRules, rateLimitAction("social-write", 60, 60000)];
  const invite = [...base, requireRules, rateLimitAction("social-invite", 12, 3600000)];
  const blocked = async (a, b, db = pool) => Boolean((await db.query(`SELECT 1 FROM letchat_blocks WHERE
    (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`, [a, b])).rowCount);
  const friends = async (a, b) => Boolean((await pool.query(`SELECT 1 FROM letchat_friends WHERE status='accepted'
    AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))`, [a, b])).rowCount);
  async function contact(a, b) {
    if (!b || a === b || await blocked(a, b)) fail("Contact indisponible", 403);
    const p = (await pool.query("SELECT private_message_policy FROM profiles WHERE user_id=$1", [b])).rows[0];
    if (!p) fail("Membre introuvable", 404);
    if (p.private_message_policy === "nobody" || (p.private_message_policy === "friends" && !await friends(a, b)))
      fail("Les préférences de ce membre ne permettent pas cette invitation", 403);
  }
  async function member(groupId, uid, db = pool) {
    const m = (await db.query(`SELECT g.*,m.joined_at FROM letchat_groups g JOIN letchat_group_members m ON m.group_id=g.id
      WHERE g.id=$1 AND m.user_id=$2 AND m.status='accepted'`, [groupId, uid])).rows[0];
    if (!m) fail("Groupe inaccessible : acceptez d’abord son invitation", 403);
    return m;
  }
  async function emitGroup(id) {
    const { rows } = await pool.query("SELECT user_id FROM letchat_group_members WHERE group_id=$1", [id]);
    for (const r of rows) io.to(`user:${r.user_id}`).emit("social-update", { kind: "group", id });
  }
  async function emitGame(game) {
    for (const id of [game.creator_id, game.opponent_id]) io.to(`user:${id}`).emit("social-update", { kind: "game", id: game.id });
  }
  async function transaction(fn) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const r = await fn(client); await client.query("COMMIT"); return r; }
    catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }
  app.get("/api/social/groups", ...base, wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT g.id,g.name,g.owner_id,m.status,g.created_at,
      (SELECT count(*)::int FROM letchat_group_members mm WHERE mm.group_id=g.id AND mm.status='accepted') AS members
      FROM letchat_groups g JOIN letchat_group_members m ON m.group_id=g.id WHERE m.user_id=$1
      ORDER BY g.created_at DESC LIMIT 50`, [req.user.id]);
    res.json(rows);
  }));
  app.post("/api/social/groups", ...invite, wrap(async (req, res) => {
    const name = clean(req.body.name, 60), ids = [...new Set(Array.isArray(req.body.members) ? req.body.members.map(x => clean(x, 200)) : [])];
    if (!name || !ids.length || ids.length > 7 || ids.includes(req.user.id)) fail("Choisissez un nom et de 1 à 7 invités");
    for (const id of ids) await contact(req.user.id, id);
    const id = randomUUID();
    await transaction(async db => {
      await db.query("INSERT INTO letchat_groups(id,name,owner_id) VALUES($1,$2,$3)", [id, name, req.user.id]);
      await db.query("INSERT INTO letchat_group_members(group_id,user_id,status) VALUES($1,$2,'accepted')", [id, req.user.id]);
      for (const uid of ids) await db.query("INSERT INTO letchat_group_members(group_id,user_id,status) VALUES($1,$2,'pending')", [id, uid]);
    });
    await emitGroup(id); res.status(201).json({ id });
  }));
  app.post("/api/social/groups/:id/accept", ...write, wrap(async (req, res) => {
    await transaction(async db => {
      const group = (await db.query("SELECT * FROM letchat_groups WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
      if (!group) fail("Groupe introuvable", 404);
      const { rows } = await db.query("SELECT user_id FROM letchat_group_members WHERE group_id=$1 AND status='accepted'", [group.id]);
      for (const r of rows) if (await blocked(req.user.id, r.user_id, db)) fail("Un blocage empêche de rejoindre ce groupe", 403);
      const result = await db.query("UPDATE letchat_group_members SET status='accepted',joined_at=NOW() WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id", [group.id, req.user.id]);
      if (!result.rowCount) fail("Invitation introuvable", 404);
    });
    await emitGroup(req.params.id); res.json({ ok: true });
  }));
  app.delete("/api/social/groups/:id/membership", ...write, wrap(async (req, res) => {
    const group = (await pool.query("SELECT * FROM letchat_groups WHERE id=$1", [req.params.id])).rows[0];
    if (!group) fail("Groupe introuvable", 404);
    const recipients = (await pool.query("SELECT user_id FROM letchat_group_members WHERE group_id=$1", [group.id])).rows;
    if (group.owner_id === req.user.id) {
      await pool.query("DELETE FROM letchat_groups WHERE id=$1", [group.id]);
      for (const r of recipients) io.to(`user:${r.user_id}`).emit("social-update", { kind: "group", id: group.id });
      live.closeScope(`group:${group.id}`);
    } else {
      await pool.query("DELETE FROM letchat_group_members WHERE group_id=$1 AND user_id=$2", [group.id, req.user.id]);
      live.removeUser(req.user.id, `group:${group.id}`); await emitGroup(group.id);
    }
    io.to(`user:${req.user.id}`).emit("social-update", { kind: "group", id: group.id });
    res.json({ ok: true });
  }));
  app.get("/api/social/groups/:id", ...base, wrap(async (req, res) => {
    const group = await member(req.params.id, req.user.id);
    const { rows } = await pool.query(`SELECT p.user_id,p.display_name,m.status FROM letchat_group_members m
      JOIN profiles p ON p.user_id=m.user_id WHERE group_id=$1 ORDER BY m.joined_at`, [group.id]);
    res.json({ ...group, members: rows });
  }));
  app.get("/api/social/groups/:id/messages", ...base, wrap(async (req, res) => {
    const group = await member(req.params.id, req.user.id);
    const { rows } = await pool.query(`SELECT m.id,m.sender_id,m.sender_name,m.body,m.media_type,m.created_at,m.expires_at
      FROM letchat_group_messages m WHERE m.group_id=$1 AND m.expires_at>NOW() AND m.created_at >= $3
      AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=m.sender_id) OR (b.blocked_id=$2 AND b.blocker_id=m.sender_id))
      ORDER BY m.id DESC LIMIT 100`, [group.id, req.user.id, group.joined_at]);
    res.json(rows.reverse());
  }));
  app.post("/api/social/groups/:id/messages", ...write, rateLimitAction("group-messages", 8, 10000), wrap(async (req, res) => {
    await member(req.params.id, req.user.id);
    const body = clean(req.body.body, 4000), { media, mediaType } = await validateMedia(req.body.mediaBase64, req.body.mediaType);
    if (!body && !media) fail("Message vide");
    const message = await transaction(async db => {
      const access = await db.query("SELECT 1 FROM letchat_group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted' FOR SHARE", [req.params.id, req.user.id]);
      if (!access.rowCount) fail("Groupe inaccessible", 403);
      return (await db.query(`INSERT INTO letchat_group_messages(group_id,sender_id,sender_name,body,media_data,media_type)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [req.params.id, req.user.id, req.user.name, body, media, mediaType])).rows[0];
    });
    await emitGroup(req.params.id); res.status(201).json(message);
  }));
  app.get("/api/social/group-media/:id", ...base, wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) fail("Média introuvable", 404);
    const row = (await pool.query("SELECT * FROM letchat_group_messages WHERE id=$1 AND expires_at>NOW()", [req.params.id])).rows[0];
    if (!row || !row.media_data) fail("Média expiré", 404);
    const g = await member(row.group_id, req.user.id);
    if (new Date(row.created_at) < new Date(g.joined_at) || await blocked(req.user.id, row.sender_id)) fail("Média indisponible", 403);
    serveMedia(res, row.media_data, row.media_type);
  }));
  app.delete("/api/social/groups/:id/messages/:message", ...write, wrap(async (req, res) => {
    const g = await member(req.params.id, req.user.id);
    if (!/^\d+$/.test(req.params.message)) fail("Message introuvable", 404);
    await pool.query("DELETE FROM letchat_group_messages WHERE id=$1 AND group_id=$2 AND (sender_id=$3 OR $4)", [req.params.message, g.id, req.user.id, g.owner_id === req.user.id]);
    await emitGroup(g.id); res.json({ ok: true });
  }));
  app.get("/api/social/games", ...base, wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT g.*,a.display_name AS creator_name,b.display_name AS opponent_name FROM letchat_games g
      JOIN profiles a ON a.user_id=g.creator_id JOIN profiles b ON b.user_id=g.opponent_id
      WHERE (creator_id=$1 OR opponent_id=$1) AND expires_at>NOW()
      AND NOT EXISTS(SELECT 1 FROM letchat_blocks bl WHERE (bl.blocker_id=g.creator_id AND bl.blocked_id=g.opponent_id) OR (bl.blocked_id=g.creator_id AND bl.blocker_id=g.opponent_id))
      ORDER BY created_at DESC LIMIT 30`, [req.user.id]);
    res.json(rows);
  }));
  app.post("/api/social/games", ...invite, wrap(async (req, res) => {
    const kind = req.body.kind, other = clean(req.body.opponentId, 200);
    if (!["connect4", "tictactoe"].includes(kind)) fail("Jeu inconnu");
    await contact(req.user.id, other);
    const existing = (await pool.query(`SELECT id FROM letchat_games WHERE kind=$3 AND status IN ('pending','active') AND expires_at>NOW()
      AND ((creator_id=$1 AND opponent_id=$2) OR (creator_id=$2 AND opponent_id=$1)) LIMIT 1`, [req.user.id, other, kind])).rows[0];
    if (existing) return res.json(existing);
    const { rows } = await pool.query(`INSERT INTO letchat_games(id,kind,creator_id,opponent_id,board)
      VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`, [randomUUID(), kind, req.user.id, other, JSON.stringify(Array(kind === "connect4" ? 42 : 9).fill(0))]);
    await emitGame(rows[0]); res.status(201).json({ id: rows[0].id });
  }));
  app.post("/api/social/games/:id/action", ...write, wrap(async (req, res) => {
    const game = await transaction(async db => {
      const g = (await db.query("SELECT * FROM letchat_games WHERE id=$1 AND expires_at>NOW() FOR UPDATE", [req.params.id])).rows[0];
      if (!g || ![g.creator_id, g.opponent_id].includes(req.user.id)) fail("Partie inaccessible", 404);
      if (await blocked(g.creator_id, g.opponent_id, db)) fail("Partie interrompue par un blocage", 403);
      let patch;
      if (req.body.action === "accept" && g.opponent_id === req.user.id && g.status === "pending") patch = { status: "active", turn_id: g.creator_id };
      else if (req.body.action === "decline" && g.status === "pending") patch = { status: "declined", turn_id: null };
      else if (req.body.action === "resign" && g.status === "active") patch = { status: "won", turn_id: null, winner_id: req.user.id === g.creator_id ? g.opponent_id : g.creator_id };
      else if (req.body.action === "move") {
        if (Number(req.body.version) !== g.version) fail("La partie a changé. Réessayez.", 409);
        patch = playMove(g, req.user.id, req.body.move);
      } else fail("Action indisponible", 409);
      Object.assign(g, patch);
      return (await db.query(`UPDATE letchat_games SET board=$2::jsonb,status=$3,turn_id=$4,winner_id=$5,version=version+1 WHERE id=$1 RETURNING *`,
        [g.id, JSON.stringify(g.board), g.status, g.turn_id, g.winner_id])).rows[0];
    });
    await emitGame(game); res.json(game);
  }));
  async function profileAccess(owner, viewer) {
    if (owner !== viewer && await blocked(owner, viewer)) fail("Profil indisponible", 403);
    const row = (await pool.query("SELECT * FROM letchat_profile_extras WHERE user_id=$1", [owner])).rows[0];
    if (row?.visibility === "friends" && owner !== viewer && !await friends(owner, viewer)) return null;
    return row;
  }
  app.get("/api/social/profile/:id", ...base, wrap(async (req, res) => {
    const p = await profileAccess(req.params.id, req.user.id);
    res.json(p ? { character: p.character, likes: p.likes, looking_for: p.looking_for, visibility: p.visibility,
      cover: Boolean(p.cover_data), voice: Boolean(p.voice_data), updated_at: p.updated_at } : { restricted: true });
  }));
  app.get("/api/social/profile/:id/:media", ...base, wrap(async (req, res) => {
    const p = await profileAccess(req.params.id, req.user.id), key = req.params.media;
    if (!p || !["cover", "voice"].includes(key) || !p[`${key}_data`]) fail("Média inaccessible", 404);
    serveMedia(res, p[`${key}_data`], p[`${key}_type`]);
  }));
  app.put("/api/social/profile", ...write, wrap(async (req, res) => {
    const b = req.body;
    const visibility = b.visibility === "friends" ? "friends" : "public";
    const change = {};
    for (const key of ["cover", "voice"]) if (Object.hasOwn(b, `${key}Base64`)) {
      const { media, mediaType } = await validateMedia(b[`${key}Base64`], b[`${key}Type`]);
      if (media && (!mediaType.startsWith(key === "cover" ? "image/" : "audio/") || media.length > 2000000)) fail("Couverture ou présentation trop volumineuse (2 Mo) ou format incorrect", 413);
      change[key] = { media, mediaType };
    }
    await transaction(async db => {
      await db.query(`INSERT INTO letchat_profile_extras(user_id,character,likes,looking_for,visibility) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id) DO UPDATE SET character=EXCLUDED.character,likes=EXCLUDED.likes,looking_for=EXCLUDED.looking_for,visibility=EXCLUDED.visibility,updated_at=NOW()`,
        [req.user.id, clean(b.character, 280), clean(b.likes, 280), clean(b.looking_for, 280), visibility]);
      for (const [key, value] of Object.entries(change)) await db.query(`UPDATE letchat_profile_extras SET ${key}_data=$2,${key}_type=$3 WHERE user_id=$1`, [req.user.id, value.media, value.mediaType]);
    });
    res.json({ ok: true });
  }));
  const live = installLive({ io, pool, blocked, member, hasPremiumAccess, roomCatalog, socketSessionValid });
  return {
    live,
    async prune() {
      await pool.query("DELETE FROM letchat_group_messages WHERE expires_at<=NOW()");
      await pool.query("DELETE FROM letchat_games WHERE expires_at<=NOW()");
      await pool.query("DELETE FROM letchat_group_members WHERE status='pending' AND joined_at<NOW()-INTERVAL '7 days'");
      await live.prune();
    },
    async exportData(id) {
      const profile = (await pool.query("SELECT character,likes,looking_for,visibility,cover_type,voice_type FROM letchat_profile_extras WHERE user_id=$1", [id])).rows[0];
      const groups = (await pool.query("SELECT g.id,g.name,m.status FROM letchat_groups g JOIN letchat_group_members m ON m.group_id=g.id WHERE m.user_id=$1", [id])).rows;
      const messages = (await pool.query("SELECT id,group_id,body,media_type,created_at FROM letchat_group_messages WHERE sender_id=$1", [id])).rows;
      const games = (await pool.query("SELECT * FROM letchat_games WHERE creator_id=$1 OR opponent_id=$1", [id])).rows;
      return { profile, groups, messages, games };
    }
  };
}
