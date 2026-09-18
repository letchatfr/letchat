import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { Server } from "socket.io";
import Stripe from "stripe";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

function signToken(user) {
  return jwt.sign(
    { id: user.id, pseudo: user.pseudo, email: user.email },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Non connecté" });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session invalide" });
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      pseudo VARCHAR(20) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan VARCHAR(20) NOT NULL DEFAULT 'Gratuit',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS messages_general_idx
      ON messages(recipient_id, created_at);

    CREATE INDEX IF NOT EXISTS messages_private_idx
      ON messages(sender_id, recipient_id, created_at);
  `);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "letchat" });
});

app.post("/api/register", async (req, res) => {
  try {
    const pseudo = String(req.body.pseudo || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!/^[A-Za-z0-9À-ÿ_ -]{3,20}$/.test(pseudo)) {
      return res.status(400).json({ error: "Pseudo invalide (3 à 20 caractères)." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Adresse e-mail invalide." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Mot de passe : 8 caractères minimum." });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (pseudo, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, pseudo, email, plan`,
      [pseudo, email, hash]
    );

    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Pseudo ou e-mail déjà utilisé." });
    }
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, pseudo, email, password_hash, plan FROM users WHERE email = $1`,
      [email]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
    }

    res.json({
      token: signToken(user),
      user: { id: user.id, pseudo: user.pseudo, email: user.email, plan: user.plan }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, pseudo, email, plan FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Compte introuvable." });
  res.json({ user: result.rows[0] });
});

app.get("/api/users", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, pseudo, plan FROM users WHERE id <> $1 ORDER BY pseudo LIMIT 200`,
    [req.user.id]
  );
  res.json({ users: result.rows });
});

app.get("/api/messages/general", auth, async (_req, res) => {
  const result = await pool.query(`
    SELECT m.id, m.body, m.created_at, u.id AS sender_id, u.pseudo AS sender
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.recipient_id IS NULL
    ORDER BY m.created_at DESC
    LIMIT 100
  `);
  res.json({ messages: result.rows.reverse() });
});

app.get("/api/messages/private/:userId", auth, async (req, res) => {
  const otherId = Number(req.params.userId);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: "Utilisateur invalide." });

  const result = await pool.query(`
    SELECT m.id, m.body, m.created_at, u.id AS sender_id, u.pseudo AS sender
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE (m.sender_id = $1 AND m.recipient_id = $2)
       OR (m.sender_id = $2 AND m.recipient_id = $1)
    ORDER BY m.created_at DESC
    LIMIT 100
  `, [req.user.id, otherId]);

  res.json({ messages: result.rows.reverse() });
});

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token || "", JWT_SECRET);
    next();
  } catch {
    next(new Error("Non autorisé"));
  }
});

const online = new Map(); // userId -> Set(socketId)

function broadcastPresence() {
  const onlineIds = [...online.keys()];
  io.emit("presence:update", onlineIds);
}

io.on("connection", (socket) => {
  const userId = Number(socket.user.id);
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socket.id);
  broadcastPresence();

  socket.on("message:send", async (payload, ack) => {
    try {
      const body = String(payload?.body || "").trim();
      const recipientId = payload?.recipientId == null ? null : Number(payload.recipientId);

      if (!body || body.length > 2000) {
        return ack?.({ ok: false, error: "Message invalide." });
      }
      if (recipientId !== null && (!Number.isInteger(recipientId) || recipientId === userId)) {
        return ack?.({ ok: false, error: "Destinataire invalide." });
      }

      if (recipientId !== null) {
        const check = await pool.query(`SELECT id, pseudo FROM users WHERE id = $1`, [recipientId]);
        if (!check.rows[0]) return ack?.({ ok: false, error: "Utilisateur introuvable." });
      }

      const result = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, body)
         VALUES ($1, $2, $3)
         RETURNING id, body, created_at`,
        [userId, recipientId, body]
      );

      const sender = await pool.query(`SELECT id, pseudo FROM users WHERE id = $1`, [userId]);
      const message = {
        id: result.rows[0].id,
        body: result.rows[0].body,
        created_at: result.rows[0].created_at,
        sender_id: userId,
        sender: sender.rows[0].pseudo
      };

      if (recipientId === null) {
        io.emit("message:new", { room: "general", message });
      } else {
        for (const [uid, sockets] of [
          [userId, online.get(userId)],
          [recipientId, online.get(recipientId)]
        ]) {
          sockets?.forEach((sid) => {
            io.to(sid).emit("message:new", { room: "private", partnerId: uid === userId ? recipientId : userId, message });
          });
        }
      }
      ack?.({ ok: true, message });
    } catch (err) {
      console.error(err);
      ack?.({ ok: false, error: "Impossible d'envoyer le message." });
    }
  });

  socket.on("disconnect", () => {
    const set = online.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) online.delete(userId);
    }
    broadcastPresence();
  });
});

async function start() {
  await initDb();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Letchat listening on 0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
