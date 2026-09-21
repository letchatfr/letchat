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

const jwks = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// Nouvelle table sans conflit avec les anciennes versions.
await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_messages (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    author TEXT NOT NULL,
    photo TEXT,
    body TEXT NOT NULL DEFAULT '',
    media_data BYTEA,
    media_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_letchat_messages_created
  ON letchat_messages(created_at);
`);

// Proxy nécessaire à la connexion Google sur Render.
app.use("/__/auth", async (req, res) => {
  try {
    const target = new URL(
      req.originalUrl,
      `https://${projectId}.firebaseapp.com`
    );

    const headers = {
      accept: req.headers.accept || "*/*",
      "user-agent": req.headers["user-agent"] || "Letchat"
    };

    if (req.headers["content-type"]) {
      headers["content-type"] = req.headers["content-type"];
    }

    const hasBody = !["GET", "HEAD"].includes(req.method);

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      ...(hasBody ? { duplex: "half" } : {})
    });

    res.status(upstream.status);

    upstream.headers.forEach((value, key) => {
      const ignoredHeaders = [
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection"
      ];

      if (!ignoredHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error("Firebase auth proxy:", error);
    res
      .status(502)
      .send("Service de connexion temporairement indisponible");
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
    const token =
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      req.query.t;

    if (!token) {
      throw new Error("Jeton absent");
    }

    req.user = await verify(String(token));
    next();
  } catch {
    res.status(401).json({ error: "Connexion requise" });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/messages", auth, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        user_id,
        author,
        photo,
        body,
        media_type,
        created_at,
        (media_data IS NOT NULL) AS has_media
      FROM letchat_messages
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json(rows.reverse());
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT media_data, media_type
       FROM letchat_messages
       WHERE id = $1`,
      [req.params.id]
    );

    if (!rows[0]?.media_data) {
      return res.sendStatus(404);
    }

    res
      .type(rows[0].media_type)
      .set("Cache-Control", "private, max-age=86400")
      .send(rows[0].media_data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/messages", auth, async (req, res, next) => {
  try {
    const body = String(req.body.body || "")
      .trim()
      .slice(0, 4000);

    const mediaType = String(req.body.mediaType || "");

    const media = req.body.mediaBase64
      ? Buffer.from(String(req.body.mediaBase64), "base64")
      : null;

    if (!body && !media) {
      return res.status(400).json({
        error: "Message vide"
      });
    }

    if (media && media.length > 8e6) {
      return res.status(413).json({
        error: "Fichier trop volumineux (8 Mo maximum)"
      });
    }

    if (media && !/^(image|video)\//.test(mediaType)) {
      return res.status(415).json({
        error: "Format non accepté"
      });
    }

    const query = await pool.query(
      `INSERT INTO letchat_messages
        (user_id, author, photo, body, media_data, media_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING
        id,
        user_id,
        author,
        photo,
        body,
        media_type,
        created_at,
        (media_data IS NOT NULL) AS has_media`,
      [
        req.user.id,
        req.user.name,
        req.user.photo,
        body,
        media,
        mediaType || null
      ]
    );

    io.emit("message", query.rows[0]);
    res.status(201).json(query.rows[0]);
  } catch (error) {
    next(error);
  }
});

const online = new Map();

io.use(async (socket, next) => {
  try {
    socket.user = await verify(socket.handshake.auth?.token);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", socket => {
  online.set(socket.id, socket.user);
  io.emit("presence", [...online.values()]);

  socket.on("typing", value => {
    socket.broadcast.emit("typing", {
      name: socket.user.name,
      active: Boolean(value)
    });
  });

  socket.on("webrtc", ({ target, data }) => {
    const signal = {
      from: socket.id,
      user: socket.user,
      data
    };

    if (target) {
      io.to(target).emit("webrtc", signal);
    } else {
      socket.broadcast.emit("webrtc", signal);
    }
  });

  socket.on("disconnect", () => {
    online.delete(socket.id);
    io.emit("presence", [...online.values()]);
  });
});

// Toutes les erreurs API sont renvoyées en JSON.
app.use("/api", (_req, res) => {
  res.status(404).json({
    error: "Route API introuvable"
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: "Erreur interne du serveur"
  });
});

app.use((_req, res) => {
  res.sendFile(
    new URL("./public/index.html", import.meta.url).pathname
  );
});

server.listen(port, () => {
  console.log(`Letchat prêt sur le port ${port}`);
});
