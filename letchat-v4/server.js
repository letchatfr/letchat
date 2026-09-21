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
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
  );
  ALTER TABLE letchat_messages
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  NOT NULL DEFAULT (NOW() + INTERVAL '1 hour');
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
app.use(express.static("public"));

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
    next();
  } catch {
    res.status(401).json({ error: "Connexion requise" });
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/profile", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT city, location_visible FROM profiles WHERE user_id = $1",
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
    const locationVisible = req.body.locationVisible !== false;
    if (!city) {
      return res.status(400).json({ error: "Ville obligatoire" });
    }
    const { rows } = await pool.query(
      `INSERT INTO profiles
       (user_id, email, display_name, photo, region, department, city, location_visible)
       VALUES ($1,$2,$3,$4,'','',$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET
         email=EXCLUDED.email, display_name=EXCLUDED.display_name,
         photo=EXCLUDED.photo, region='',
         department='', city=EXCLUDED.city,
         location_visible=EXCLUDED.location_visible, updated_at=NOW()
       RETURNING city, location_visible`,
      [req.user.id, req.user.email, req.user.name, req.user.photo, city, locationVisible]
    );
    for (const [socketId, entry] of online) {
      if (entry.user.id === req.user.id) {
        entry.user.profile = rows[0];
        online.set(socketId, entry);
        emitPresence(entry.room);
      }
    }
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

const allowedRooms = new Set(["cafe", "creatifs", "entraide"]);
const getRoom = value => allowedRooms.has(String(value)) ? String(value) : "cafe";

app.get("/api/messages", auth, async (req, res, next) => {
  try {
    const room = getRoom(req.query.room);
    const { rows } = await pool.query(`
      SELECT id, user_id, author, room, photo, body, media_type, created_at, expires_at,
             (media_data IS NOT NULL) AS has_media
      FROM letchat_messages
      WHERE expires_at > NOW() AND room = $1
      ORDER BY id DESC LIMIT 100
    `, [room]);
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

const online = new Map();

function emitPresence(room) {
  const people = [...online.values()]
    .filter(entry => entry.room === room)
    .map(entry => ({
      name: entry.user.name,
      photo: entry.user.photo,
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
      "SELECT city, location_visible FROM profiles WHERE user_id = $1",
      [socket.user.id]
    );
    socket.user.profile = rows[0] || null;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", socket => {
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
