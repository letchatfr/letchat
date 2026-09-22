import express from "express";
import helmet from "helmet";
import http from "node:http";
import pg from "pg";
import { Server } from "socket.io";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });
const projectId = process.env.FIREBASE_PROJECT_ID || "letchat-1d79d";
const port = process.env.PORT || 10000;

const jwks = createRemoteJWKSet(new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// Table propre à cette version : aucun conflit avec les anciennes tables.
await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_messages (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    author TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT 'cafe',
    photo TEXT,
    body TEXT NOT NULL DEFAULT '',
    media_data BYTEA,
    media_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
  );
  ALTER TABLE letchat_messages
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  NOT NULL DEFAULT (NOW() + INTERVAL '48 hours');
  ALTER TABLE letchat_messages
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '48 hours');
  UPDATE letchat_messages
  SET expires_at = created_at + INTERVAL '48 hours'
  WHERE expires_at < created_at + INTERVAL '48 hours';
  ALTER TABLE letchat_messages
  ADD COLUMN IF NOT EXISTS room TEXT NOT NULL DEFAULT 'cafe';
  CREATE INDEX IF NOT EXISTS idx_letchat_messages_created
  ON letchat_messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_letchat_messages_expires
  ON letchat_messages(expires_at);
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL,
    photo TEXT,
    region TEXT NOT NULL,
    department TEXT NOT NULL,
    city TEXT NOT NULL,
    location_visible BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'neutral';
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_private_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_photo TEXT,
    body TEXT NOT NULL DEFAULT '',
    media_data BYTEA,
    media_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
  );
  ALTER TABLE letchat_private_messages
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '48 hours');
  UPDATE letchat_private_messages
  SET expires_at = created_at + INTERVAL '48 hours'
  WHERE expires_at < created_at + INTERVAL '48 hours';
  CREATE INDEX IF NOT EXISTS idx_letchat_private_conversation
  ON letchat_private_messages(sender_id, recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_letchat_private_expires
  ON letchat_private_messages(expires_at);
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_blocks_blocked
  ON letchat_blocks(blocked_id);
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_reports (
    id BIGSERIAL PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    reported_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (reporter_id <> reported_id)
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_reports_status
  ON letchat_reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_letchat_reports_reporter
  ON letchat_reports(reporter_id, reported_id, created_at DESC);
`);

// Proxy Firebase nécessaire à la connexion Google par redirection sur Render.
app.use("/__/auth", async (req, res) => {
  try {
    const target = new URL(req.originalUrl, `https://${projectId}.firebaseapp.com`);
    const headers = {
      accept: req.headers.accept || "*/*",
      "user-agent": req.headers["user-agent"] || "Letchat"
    };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      ...(hasBody ? { duplex: "half" } : {})
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const ignored = ["content-encoding", "content-length", "transfer-encoding", "connection"];
      if (!ignored.includes(key.toLowerCase())) res.setHeader(key, value);
    });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error("Firebase auth proxy:", error);
    res.status(502).send("Service de connexion temporairement indisponible");
  }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "9mb" }));
app.use(express.static("public", {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
}));

async function verify(token) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId
  });
  return {
    id: String(payload.sub),
    email: String(payload.email || ""),
    name: String(payload.name || payload.email || "Utilisateur"),
    photo: typeof payload.picture === "string" ? payload.picture : null
  };
}

async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.t;
    if (!token) throw new Error("Jeton absent");
    req.user = await verify(String(token));
    const { rows } = await pool.query("SELECT display_name, photo FROM profiles WHERE user_id = $1", [req.user.id]);
    if (rows[0]?.display_name) req.user.name = rows[0].display_name;
    if (rows[0]?.photo) req.user.photo = rows[0].photo;
    next();
  } catch {
    res.status(401).json({ error: "Connexion requise" });
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/profile", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT display_name, photo, city, bio, gender, location_visible FROM profiles WHERE user_id = $1",
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (error) {
    next(error);
  }
});

app.put("/api/profile", auth, async (req, res, next) => {
  try {
    const clean = value => String(value || "").trim().slice(0, 100);
    const city = clean(req.body.city);
    const displayName = clean(req.body.displayName) || req.user.name;
    const bio = String(req.body.bio || "").trim().slice(0, 280);
    const gender = ["female", "male"].includes(String(req.body.gender)) ? String(req.body.gender) : "neutral";
    const locationVisible = req.body.locationVisible !== false;
    if (!city) {
      return res.status(400).json({ error: "Ville obligatoire" });
    }
    const { rows } = await pool.query(
      `INSERT INTO profiles
       (user_id, email, display_name, photo, region, department, city, bio, gender, location_visible)
       VALUES ($1,$2,$3,$4,'','',$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET
         email=EXCLUDED.email, display_name=EXCLUDED.display_name,
         photo=EXCLUDED.photo, region='',
         department='', city=EXCLUDED.city, bio=EXCLUDED.bio, gender=EXCLUDED.gender,
         location_visible=EXCLUDED.location_visible, updated_at=NOW()
       RETURNING display_name, photo, city, bio, gender, location_visible`,
      [req.user.id, req.user.email, displayName, req.user.photo, city, bio, gender, locationVisible]
    );
    for (const [socketId, entry] of online) {
      if (entry.user.id === req.user.id) {
        entry.user.profile = rows[0];
        entry.user.name = rows[0].display_name;
        online.set(socketId, entry);
        emitPresence(entry.room);
      }
    }
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/profile/:userId", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, display_name, photo, bio, gender,
              CASE WHEN location_visible THEN city ELSE '' END AS city
       FROM profiles WHERE user_id = $1`,
      [String(req.params.userId)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Profil introuvable" });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/blocks", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.blocked_id AS user_id,
              COALESCE(p.display_name, 'Utilisateur bloqué') AS display_name,
              p.photo
       FROM letchat_blocks b
       LEFT JOIN profiles p ON p.user_id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/blocks/:userId", auth, async (req, res, next) => {
  try {
    const blockedId = String(req.params.userId || "").slice(0, 200);
    if (!blockedId || blockedId === req.user.id) {
      return res.status(400).json({ error: "Utilisateur incorrect" });
    }
    await pool.query(
      `INSERT INTO letchat_blocks (blocker_id, blocked_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, blockedId]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/blocks/:userId", auth, async (req, res, next) => {
  try {
    await pool.query(
      "DELETE FROM letchat_blocks WHERE blocker_id = $1 AND blocked_id = $2",
      [req.user.id, String(req.params.userId || "").slice(0, 200)]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/reports", auth, async (req, res, next) => {
  try {
    const reportedId = String(req.body.reportedId || "").slice(0, 200);
    const reason = String(req.body.reason || "");
    const details = String(req.body.details || "").trim().slice(0, 1000);
    const allowedReasons = new Set(["harassment", "spam", "inappropriate", "fake", "other"]);
    if (!reportedId || reportedId === req.user.id) {
      return res.status(400).json({ error: "Utilisateur incorrect" });
    }
    if (!allowedReasons.has(reason)) {
      return res.status(400).json({ error: "Motif de signalement incorrect" });
    }
    const recent = await pool.query(
      `SELECT 1 FROM letchat_reports
       WHERE reporter_id=$1 AND reported_id=$2
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [req.user.id, reportedId]
    );
    if (recent.rowCount) {
      return res.status(429).json({ error: "Vous avez déjà signalé cet utilisateur récemment" });
    }
    await pool.query(
      `INSERT INTO letchat_reports (reporter_id, reported_id, reason, details)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, reportedId, reason, details]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const allowedRooms = new Set(["cafe", "creatifs", "entraide"]);
const getRoom = value => allowedRooms.has(String(value)) ? String(value) : "cafe";

let meteredTurnCredential = null;
let meteredTurnCredentialPromise = null;

async function getMeteredTurnApiKey(domain, secretKey) {
  const now = Date.now();
  if (meteredTurnCredential?.apiKey && meteredTurnCredential.expiresAt > now) {
    return meteredTurnCredential.apiKey;
  }
  if (!meteredTurnCredentialPromise) {
    meteredTurnCredentialPromise = (async () => {
      const expiryInSeconds = 24 * 60 * 60;
      const response = await fetch(
        `https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(secretKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            expiryInSeconds,
            label: `letchat-${Date.now()}`
          })
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.apiKey) {
        throw new Error(`Création TURN refusée (${response.status})`);
      }
      meteredTurnCredential = {
        apiKey: result.apiKey,
        expiresAt: Date.now() + (expiryInSeconds - 300) * 1000
      };
      console.log("Identifiant TURN créé. Propagation Metered : jusqu’à 2 minutes.");
      return result.apiKey;
    })().finally(() => {
      meteredTurnCredentialPromise = null;
    });
  }
  return meteredTurnCredentialPromise;
}

app.get("/api/turn-credentials", auth, async (_req, res, next) => {
  try {
    const domain = String(process.env.METERED_DOMAIN || "").trim()
      .replace(/^https?:\/\//, "").replace(/\/$/, "");
    const secretKey = String(process.env.METERED_API_KEY || "").trim();
    if (!domain || !secretKey || !/^[a-z0-9.-]+\.metered\.live$/i.test(domain)) {
      return res.status(503).json({ error: "Serveur vidéo non configuré" });
    }
    const apiKey = await getMeteredTurnApiKey(domain, secretKey);
    const response = await fetch(
      `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      { headers: { accept: "application/json" } }
    );
    if (!response.ok) throw new Error(`Metered TURN a répondu ${response.status}`);
    const iceServers = await response.json();
    if (!Array.isArray(iceServers) || !iceServers.length) {
      throw new Error("Identifiants TURN absents");
    }
    res.set("Cache-Control", "private, no-store").json(iceServers);
  } catch (error) {
    next(error);
  }
});

app.get("/api/messages", auth, async (req, res, next) => {
  try {
    const room = getRoom(req.query.room);
    const { rows } = await pool.query(`
      SELECT id, user_id, author, room, photo, body, media_type, created_at, expires_at,
             (media_data IS NOT NULL) AS has_media
      FROM letchat_messages
      WHERE expires_at > NOW() AND room = $1
        AND NOT EXISTS (
          SELECT 1 FROM letchat_blocks b
          WHERE b.blocker_id = $2 AND b.blocked_id = letchat_messages.user_id
        )
      ORDER BY id DESC LIMIT 100
    `, [room, req.user.id]);
    res.json(rows.reverse());
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT media_data, media_type FROM letchat_messages WHERE id = $1 AND expires_at > NOW()",
      [req.params.id]
    );
    if (!rows[0]?.media_data) return res.sendStatus(404);
    res.type(rows[0].media_type)
      .set("Cache-Control", "private, max-age=86400")
      .send(rows[0].media_data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/messages", auth, async (req, res, next) => {
  try {
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const room = getRoom(req.body.room);
    const mediaType = String(req.body.mediaType || "");
    const media = req.body.mediaBase64
      ? Buffer.from(String(req.body.mediaBase64), "base64")
      : null;

    if (!body && !media) return res.status(400).json({ error: "Message vide" });
    if (media && media.length > 8e6) {
      return res.status(413).json({ error: "Fichier trop volumineux (8 Mo maximum)" });
    }
    if (media && !/^(image|video)\//.test(mediaType)) {
      return res.status(415).json({ error: "Format non accepté" });
    }

    const query = await pool.query(
      `INSERT INTO letchat_messages
       (user_id, author, room, photo, body, media_data, media_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, author, room, photo, body, media_type, created_at, expires_at,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, req.user.name, room, req.user.photo, body, media, mediaType || null]
    );
    io.to(room).emit("message", query.rows[0]);
    res.status(201).json(query.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/private/:otherId", auth, async (req, res, next) => {
  try {
    const otherId = String(req.params.otherId || "").slice(0, 200);
    const blocked = await pool.query(
      `SELECT 1 FROM letchat_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
      [req.user.id, otherId]
    );
    if (blocked.rowCount) return res.status(403).json({ error: "Conversation bloquée" });
    const { rows } = await pool.query(
      `SELECT id, sender_id AS user_id, recipient_id, sender_name AS author,
              sender_photo AS photo, body, media_type, created_at, expires_at,
              (media_data IS NOT NULL) AS has_media
       FROM letchat_private_messages
       WHERE expires_at > NOW()
         AND ((sender_id=$1 AND recipient_id=$2)
           OR (sender_id=$2 AND recipient_id=$1))
       ORDER BY id DESC LIMIT 100`,
      [req.user.id, otherId]
    );
    res.json(rows.reverse().map(row => ({ ...row, private: true })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/private-media/:id", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT media_data, media_type FROM letchat_private_messages
       WHERE id=$1 AND expires_at > NOW()
         AND (sender_id=$2 OR recipient_id=$2)`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]?.media_data) return res.sendStatus(404);
    res.type(rows[0].media_type)
      .set("Cache-Control", "private, no-store")
      .send(rows[0].media_data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/private", auth, async (req, res, next) => {
  try {
    const recipientId = String(req.body.recipientId || "").slice(0, 200);
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const mediaType = String(req.body.mediaType || "");
    const media = req.body.mediaBase64
      ? Buffer.from(String(req.body.mediaBase64), "base64") : null;
    if (!recipientId || recipientId === req.user.id) {
      return res.status(400).json({ error: "Destinataire incorrect" });
    }
    const blocked = await pool.query(
      `SELECT 1 FROM letchat_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
      [req.user.id, recipientId]
    );
    if (blocked.rowCount) return res.status(403).json({ error: "Message impossible : utilisateur bloqué" });
    if (!body && !media) return res.status(400).json({ error: "Message vide" });
    if (media && media.length > 8e6) {
      return res.status(413).json({ error: "Fichier trop volumineux (8 Mo maximum)" });
    }
    if (media && !/^(image|video)\//.test(mediaType)) {
      return res.status(415).json({ error: "Format non accepté" });
    }
    const { rows } = await pool.query(
      `INSERT INTO letchat_private_messages
       (sender_id,recipient_id,sender_name,sender_photo,body,media_data,media_type)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, sender_id AS user_id, sender_name AS author,
                 sender_photo AS photo, body, media_type, created_at, expires_at,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, recipientId, req.user.name, req.user.photo, body, media, mediaType || null]
    );
    const message = { ...rows[0], private: true, recipient_id: recipientId };
    io.to(`user:${req.user.id}`).to(`user:${recipientId}`).emit("private-message", message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

const online = new Map();

function emitPresence(room) {
  const people = [...online.values()]
    .filter(entry => entry.room === room)
    .map(entry => ({
      id: entry.user.id,
      name: entry.user.name,
      photo: entry.user.photo,
      bio: entry.user.profile?.bio || "",
      gender: entry.user.profile?.gender || "neutral",
      location: entry.user.profile?.location_visible ? {
        city: entry.user.profile.city
      } : null
    }));
  io.to(room).emit("presence", people);
}

io.use(async (socket, next) => {
  try {
    socket.user = await verify(socket.handshake.auth?.token);
    const { rows } = await pool.query(
      "SELECT display_name, photo, city, bio, gender, location_visible FROM profiles WHERE user_id = $1",
      [socket.user.id]
    );
    socket.user.profile = rows[0] || null;
    if (rows[0]?.display_name) socket.user.name = rows[0].display_name;
    if (rows[0]?.photo) socket.user.photo = rows[0].photo;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", socket => {
  socket.join(`user:${socket.user.id}`);
  socket.room = "cafe";
  socket.join(socket.room);
  online.set(socket.id, { user: socket.user, room: socket.room });
  emitPresence(socket.room);

  socket.on("join-room", value => {
    const nextRoom = getRoom(value);
    const previousRoom = socket.room;
    if (nextRoom === previousRoom) return emitPresence(nextRoom);
    socket.leave(previousRoom);
    socket.room = nextRoom;
    socket.join(nextRoom);
    online.set(socket.id, { user: socket.user, room: nextRoom });
    emitPresence(previousRoom);
    emitPresence(nextRoom);
  });

  socket.on("typing", value => {
    socket.to(socket.room).emit("typing", { name: socket.user.name, active: Boolean(value) });
  });

  socket.on("webrtc", ({ target, data }) => {
    const signal = { from: socket.id, user: socket.user, data };
    if (target) io.to(target).emit("webrtc", signal);
    else socket.to(socket.room).emit("webrtc", signal);
  });

  socket.on("disconnect", () => {
    const room = socket.room;
    online.delete(socket.id);
    emitPresence(room);
  });
});

async function deleteExpiredMessages() {
  try {
    const { rows } = await pool.query(
      "DELETE FROM letchat_messages WHERE expires_at <= NOW() RETURNING id"
    );
    if (rows.length) io.emit("messages-expired", rows.map(row => String(row.id)));
    const deletedPrivate = await pool.query(
      "DELETE FROM letchat_private_messages WHERE expires_at <= NOW() RETURNING id, sender_id, recipient_id"
    );
    for (const row of deletedPrivate.rows) {
      const payload = [String(row.id)];
      io.to(`user:${row.sender_id}`).to(`user:${row.recipient_id}`)
        .emit("private-messages-expired", payload);
    }
  } catch (error) {
    console.error("Suppression des messages expirés :", error);
  }
}

await deleteExpiredMessages();
setInterval(deleteExpiredMessages, 30000).unref();

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Route API introuvable" });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Erreur interne du serveur" });
});

app.use((_req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

server.listen(port, () => console.log(`Letchat prêt sur le port ${port}`));
