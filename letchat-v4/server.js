import express from "express";
import helmet from "helmet";
import http from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { Server } from "socket.io";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });
const projectId = process.env.FIREBASE_PROJECT_ID || "letchat-1d79d";
const port = process.env.PORT || 10000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

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
  ALTER TABLE letchat_messages
  ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;
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
  ALTER TABLE letchat_private_messages
  ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;
  UPDATE letchat_private_messages
  SET expires_at = created_at + INTERVAL '48 hours'
  WHERE expires_at < created_at + INTERVAL '48 hours';
  CREATE INDEX IF NOT EXISTS idx_letchat_private_conversation
  ON letchat_private_messages(sender_id, recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_letchat_private_expires
  ON letchat_private_messages(expires_at);
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_message_reactions (
    message_kind TEXT NOT NULL CHECK (message_kind IN ('public', 'private')),
    message_id BIGINT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_kind, message_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_reactions_message
  ON letchat_message_reactions(message_kind, message_id);
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
  CREATE TABLE IF NOT EXISTS letchat_friends (
    id BIGSERIAL PRIMARY KEY,
    requester_id TEXT NOT NULL,
    addressee_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (requester_id <> addressee_id),
    CHECK (status IN ('pending', 'accepted'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_letchat_friends_pair
  ON letchat_friends (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
  CREATE INDEX IF NOT EXISTS idx_letchat_friends_requester ON letchat_friends(requester_id);
  CREATE INDEX IF NOT EXISTS idx_letchat_friends_addressee ON letchat_friends(addressee_id);
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

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_suspensions (
    user_id TEXT PRIMARY KEY,
    suspended_until TIMESTAMPTZ,
    reason TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    actor_id TEXT,
    reference_id TEXT,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_notifications_user
  ON letchat_notifications(user_id, created_at DESC);
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_consents (
    user_id TEXT PRIMARY KEY,
    rules_version TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_age_consents (
    user_id TEXT PRIMARY KEY,
    over_18 BOOLEAN NOT NULL CHECK (over_18 = TRUE),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_subscriptions (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL DEFAULT '',
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'free',
    current_period_end TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE letchat_subscriptions ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'premium';
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
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = String(session.client_reference_id || session.metadata?.userId || "");
      if (userId && session.customer) {
        const subscription = session.subscription
          ? await stripe.subscriptions.retrieve(String(session.subscription))
          : null;
        await pool.query(
          `INSERT INTO letchat_subscriptions
           (user_id,email,stripe_customer_id,stripe_subscription_id,status,current_period_end,plan,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email,
             stripe_customer_id=EXCLUDED.stripe_customer_id,
             stripe_subscription_id=EXCLUDED.stripe_subscription_id,
             status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,
             plan=EXCLUDED.plan,updated_at=NOW()`,
          [userId, session.customer_details?.email || "", String(session.customer),
           subscription?.id || null, subscription?.status || "active",
           subscription?.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
           String(session.metadata?.plan || subscription?.metadata?.plan || "premium")]
        );
      }
    }
    if (["customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const subscription = event.data.object;
      await pool.query(
        `UPDATE letchat_subscriptions SET status=$1,current_period_end=$2,updated_at=NOW()
         WHERE stripe_subscription_id=$3 OR stripe_customer_id=$4`,
        [subscription.status,
         subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
         subscription.id, String(subscription.customer)]
      );
    }
    res.json({ received: true });
  } catch (error) {
    console.error("Webhook Stripe :", error.message);
    res.status(400).send("Webhook incorrect");
  }
});
app.use(express.json({ limit: "12mb" }));
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

function isAdminUser(user) {
  const emails = String(process.env.ADMIN_EMAIL || "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const ids = String(process.env.ADMIN_UID || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  return emails.includes(String(user.email || "").toLowerCase()) || ids.includes(String(user.id));
}

async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.t;
    if (!token) throw new Error("Jeton absent");
    req.user = await verify(String(token));
    if (!isAdminUser(req.user)) {
      const suspension = await pool.query(
        `SELECT suspended_until FROM letchat_suspensions
         WHERE user_id=$1 AND (suspended_until IS NULL OR suspended_until > NOW())`,
        [req.user.id]
      );
      if (suspension.rowCount) {
        return res.status(403).json({ error: "Compte suspendu par la modération" });
      }
    }
    const { rows } = await pool.query("SELECT display_name, photo FROM profiles WHERE user_id = $1", [req.user.id]);
    if (rows[0]?.display_name) req.user.name = rows[0].display_name;
    if (rows[0]?.photo) req.user.photo = rows[0].photo;
    next();
  } catch {
    res.status(401).json({ error: "Connexion requise" });
  }
}

function adminAuth(req, res, next) {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Accès administrateur interdit" });
  }
  next();
}

async function createNotification(userId, type, title, body = "", actorId = null, referenceId = null) {
  const { rows } = await pool.query(
    `INSERT INTO letchat_notifications
     (user_id, type, title, body, actor_id, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, type, title, body, actor_id, reference_id, read_at, created_at`,
    [userId, type, title, body, actorId, referenceId]
  );
  io.to(`user:${userId}`).emit("notification", rows[0]);
  return rows[0];
}

const RULES_VERSION = "2026-09-22-v1";
const actionBuckets = new Map();

async function requireRules(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT 1 FROM letchat_consents WHERE user_id=$1 AND rules_version=$2",
      [req.user.id, RULES_VERSION]
    );
    if (!result.rowCount) {
      return res.status(403).json({ error: "Vous devez accepter les règles de la communauté" });
    }
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdult(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT 1 FROM letchat_age_consents WHERE user_id=$1 AND over_18=TRUE",
      [req.user.id]
    );
    if (!result.rowCount) {
      return res.status(403).json({ error: "Vous devez confirmer que vous avez au moins 18 ans" });
    }
    next();
  } catch (error) {
    next(error);
  }
}

function rateLimitAction(name, maximum, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.user.id}`;
    const now = Date.now();
    const recent = (actionBuckets.get(key) || []).filter(time => now - time < windowMs);
    if (recent.length >= maximum) {
      const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      res.set("Retry-After", String(retrySeconds));
      return res.status(429).json({ error: `Trop d’actions. Réessayez dans ${retrySeconds} secondes` });
    }
    recent.push(now);
    actionBuckets.set(key, recent);
    next();
  };
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/public-config", (_req, res) => {
  res.json({
    contactEmail: String(process.env.CONTACT_EMAIL || "").trim(),
    premiumConfigured: Boolean(stripe && process.env.STRIPE_PRICE_ID),
    premiumPlusConfigured: Boolean(stripe && process.env.STRIPE_PRICE_PLUS_ID)
  });
});

app.get("/api/subscription", auth, requireAdult, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT status,current_period_end,stripe_customer_id,plan FROM letchat_subscriptions WHERE user_id=$1",
      [req.user.id]
    );
    const row = rows[0];
    const premium = Boolean(row && ["active", "trialing"].includes(row.status));
    res.json({ premium, plan: row?.plan || null, status: row?.status || "free", currentPeriodEnd: row?.current_period_end || null, canManage: Boolean(row?.stripe_customer_id) });
  } catch (error) { next(error); }
});

app.post("/api/stripe/checkout", auth, requireAdult, rateLimitAction("stripe-checkout", 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const plan = req.body?.plan === "premium_plus" ? "premium_plus" : "premium";
    const priceId = plan === "premium_plus" ? process.env.STRIPE_PRICE_PLUS_ID : process.env.STRIPE_PRICE_ID;
    if (!stripe || !priceId) return res.status(503).json({ error: "Cette formule est temporairement indisponible" });
    const existing = await pool.query("SELECT stripe_customer_id FROM letchat_subscriptions WHERE user_id=$1", [req.user.id]);
    const baseUrl = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const params = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/?premium=success`,
      cancel_url: `${baseUrl}/?premium=cancel`,
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, plan },
      subscription_data: { metadata: { userId: req.user.id, plan } },
      allow_promotion_codes: true
    };
    if (existing.rows[0]?.stripe_customer_id) params.customer = existing.rows[0].stripe_customer_id;
    else params.customer_email = req.user.email;
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (error) { next(error); }
});

app.post("/api/stripe/portal", auth, requireAdult, rateLimitAction("stripe-portal", 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Portail Stripe indisponible" });
    const { rows } = await pool.query("SELECT stripe_customer_id FROM letchat_subscriptions WHERE user_id=$1", [req.user.id]);
    if (!rows[0]?.stripe_customer_id) return res.status(404).json({ error: "Aucun abonnement Stripe associé" });
    const baseUrl = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const session = await stripe.billingPortal.sessions.create({ customer: rows[0].stripe_customer_id, return_url: `${baseUrl}/` });
    res.json({ url: session.url });
  } catch (error) { next(error); }
});

app.get("/api/age-status", auth, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT accepted_at FROM letchat_age_consents WHERE user_id=$1 AND over_18=TRUE",
      [req.user.id]
    );
    res.json({ accepted: Boolean(result.rowCount), minimumAge: 18 });
  } catch (error) {
    next(error);
  }
});

app.post("/api/age-accept", auth, rateLimitAction("age", 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    if (req.body.over18 !== true) {
      return res.status(400).json({ error: "Letchat est réservé aux personnes âgées de 18 ans ou plus" });
    }
    await pool.query(
      `INSERT INTO letchat_age_consents (user_id, over_18, accepted_at)
       VALUES ($1,TRUE,NOW())
       ON CONFLICT (user_id) DO UPDATE SET over_18=TRUE, accepted_at=NOW()`,
      [req.user.id]
    );
    res.json({ ok: true, minimumAge: 18 });
  } catch (error) {
    next(error);
  }
});

app.get("/api/account-export", auth, requireAdult, rateLimitAction("export", 3, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [profile, publicMessages, privateMessages, friends, blocks, notifications, reports, consents] = await Promise.all([
      pool.query("SELECT user_id,email,display_name,photo,city,bio,gender,location_visible,updated_at FROM profiles WHERE user_id=$1", [uid]),
      pool.query("SELECT id,author,room,body,media_type,created_at,expires_at FROM letchat_messages WHERE user_id=$1 ORDER BY created_at", [uid]),
      pool.query(`SELECT id,sender_id,recipient_id,sender_name,body,media_type,created_at,expires_at
                  FROM letchat_private_messages WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at`, [uid]),
      pool.query("SELECT id,requester_id,addressee_id,status,created_at,updated_at FROM letchat_friends WHERE requester_id=$1 OR addressee_id=$1", [uid]),
      pool.query("SELECT blocker_id,blocked_id,created_at FROM letchat_blocks WHERE blocker_id=$1 OR blocked_id=$1", [uid]),
      pool.query("SELECT id,type,title,body,actor_id,reference_id,read_at,created_at FROM letchat_notifications WHERE user_id=$1 ORDER BY created_at", [uid]),
      pool.query("SELECT id,reporter_id,reported_id,reason,details,status,created_at FROM letchat_reports WHERE reporter_id=$1 OR reported_id=$1 ORDER BY created_at", [uid]),
      pool.query(`SELECT 'rules' AS type,rules_version AS version,accepted_at FROM letchat_consents WHERE user_id=$1
                  UNION ALL SELECT 'age','18+',accepted_at FROM letchat_age_consents WHERE user_id=$1`, [uid])
    ]);
    const data = {
      exportedAt: new Date().toISOString(),
      account: { userId: uid, googleEmail: req.user.email, googleName: req.user.name },
      profile: profile.rows[0] || null,
      publicMessages: publicMessages.rows,
      privateMessages: privateMessages.rows,
      friends: friends.rows,
      blocks: blocks.rows,
      notifications: notifications.rows,
      reports: reports.rows,
      consents: consents.rows,
      note: "Les fichiers image et vidéo binaires ne sont pas inclus dans cet export JSON. Leurs types sont indiqués."
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=letchat-donnees-${new Date().toISOString().slice(0,10)}.json`);
    res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/account", auth, requireAdult, rateLimitAction("delete-account", 2, 24 * 60 * 60 * 1000), async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body.confirmation !== "SUPPRIMER") {
      return res.status(400).json({ error: "Confirmation incorrecte" });
    }
    const uid = req.user.id;
    const billing = await client.query("SELECT status FROM letchat_subscriptions WHERE user_id=$1", [uid]);
    if (billing.rows[0] && ["active", "trialing", "past_due"].includes(billing.rows[0].status)) {
      return res.status(409).json({ error: "Annulez d’abord votre abonnement Premium depuis le portail Stripe" });
    }
    const anonymousId = `compte-supprime-${createHash("sha256").update(uid).digest("hex").slice(0,24)}`;
    await client.query("BEGIN");
    await client.query("DELETE FROM letchat_message_reactions WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_messages WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_private_messages WHERE sender_id=$1 OR recipient_id=$1", [uid]);
    await client.query("DELETE FROM letchat_friends WHERE requester_id=$1 OR addressee_id=$1", [uid]);
    await client.query("DELETE FROM letchat_blocks WHERE blocker_id=$1 OR blocked_id=$1", [uid]);
    await client.query("DELETE FROM letchat_notifications WHERE user_id=$1 OR actor_id=$1", [uid]);
    await client.query("UPDATE letchat_reports SET reporter_id=$2 WHERE reporter_id=$1", [uid, anonymousId]);
    await client.query("UPDATE letchat_reports SET reported_id=$2 WHERE reported_id=$1", [uid, anonymousId]);
    await client.query("DELETE FROM letchat_suspensions WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_consents WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_age_consents WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_subscriptions WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM profiles WHERE user_id=$1", [uid]);
    await client.query("COMMIT");
    io.to(`user:${uid}`).emit("account-deleted");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/rules-status", auth, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT accepted_at FROM letchat_consents WHERE user_id=$1 AND rules_version=$2",
      [req.user.id, RULES_VERSION]
    );
    res.json({ accepted: Boolean(result.rowCount), version: RULES_VERSION });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rules-accept", auth, rateLimitAction("rules", 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    if (req.body.accepted !== true) {
      return res.status(400).json({ error: "Vous devez confirmer votre accord" });
    }
    await pool.query(
      `INSERT INTO letchat_consents (user_id, rules_version, accepted_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE SET rules_version=EXCLUDED.rules_version, accepted_at=NOW()`,
      [req.user.id, RULES_VERSION]
    );
    res.json({ ok: true, version: RULES_VERSION });
  } catch (error) {
    next(error);
  }
});

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
    await pool.query(
      `DELETE FROM letchat_friends
       WHERE (requester_id=$1 AND addressee_id=$2)
          OR (requester_id=$2 AND addressee_id=$1)`,
      [req.user.id, blockedId]
    );
    io.to(`user:${blockedId}`).emit("friends-updated");
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

app.get("/api/notifications", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.title, n.body, n.actor_id, n.reference_id,
              n.read_at, n.created_at,
              COALESCE(p.display_name, '') AS actor_name, p.photo AS actor_photo
       FROM letchat_notifications n
       LEFT JOIN profiles p ON p.user_id = n.actor_id
       WHERE n.user_id=$1 AND n.created_at > NOW() - INTERVAL '30 days'
       ORDER BY n.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/notifications/read", auth, async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE letchat_notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=$1",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/notifications/:id/read", auth, async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE letchat_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/friends", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.requester_id, f.addressee_id, f.status, f.created_at,
              CASE WHEN f.requester_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction,
              CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END AS user_id,
              COALESCE(p.display_name, 'Utilisateur') AS display_name,
              p.photo, p.bio, p.gender
       FROM letchat_friends f
       LEFT JOIN profiles p ON p.user_id = CASE
         WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.requester_id=$1 OR f.addressee_id=$1
       ORDER BY f.updated_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/friends/:userId", auth, requireRules, rateLimitAction("friends", 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const otherId = String(req.params.userId || "").slice(0, 200);
    if (!otherId || otherId === req.user.id) {
      return res.status(400).json({ error: "Utilisateur incorrect" });
    }
    const blocked = await pool.query(
      `SELECT 1 FROM letchat_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
      [req.user.id, otherId]
    );
    if (blocked.rowCount) return res.status(403).json({ error: "Demande impossible : utilisateur bloqué" });
    const existing = await pool.query(
      `SELECT id, requester_id, addressee_id, status FROM letchat_friends
       WHERE (requester_id=$1 AND addressee_id=$2)
          OR (requester_id=$2 AND addressee_id=$1) LIMIT 1`,
      [req.user.id, otherId]
    );
    if (existing.rowCount) {
      return res.status(409).json({ error: existing.rows[0].status === "accepted" ? "Vous êtes déjà amis" : "Une demande existe déjà" });
    }
    const result = await pool.query(
      `INSERT INTO letchat_friends (requester_id, addressee_id)
       VALUES ($1, $2) RETURNING id, requester_id, addressee_id, status`,
      [req.user.id, otherId]
    );
    await createNotification(
      otherId, "friend_request", "Nouvelle demande d’ami",
      `${req.user.name} souhaite devenir votre ami.`, req.user.id, String(result.rows[0].id)
    );
    io.to(`user:${otherId}`).emit("friends-updated");
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/friends/:id", auth, async (req, res, next) => {
  try {
    if (String(req.body.action) !== "accept") {
      return res.status(400).json({ error: "Action incorrecte" });
    }
    const result = await pool.query(
      `UPDATE letchat_friends SET status='accepted', updated_at=NOW()
       WHERE id=$1 AND addressee_id=$2 AND status='pending'
       RETURNING requester_id, addressee_id`,
      [req.params.id, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Demande introuvable" });
    await createNotification(
      result.rows[0].requester_id, "friend_accepted", "Demande d’ami acceptée",
      `${req.user.name} a accepté votre demande.`, req.user.id, String(req.params.id)
    );
    io.to(`user:${result.rows[0].requester_id}`).emit("friends-updated");
    io.to(`user:${result.rows[0].addressee_id}`).emit("friends-updated");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/friends/:id", auth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM letchat_friends
       WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)
       RETURNING requester_id, addressee_id`,
      [req.params.id, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Relation introuvable" });
    const otherId = result.rows[0].requester_id === req.user.id
      ? result.rows[0].addressee_id : result.rows[0].requester_id;
    io.to(`user:${otherId}`).emit("friends-updated");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/reports", auth, rateLimitAction("reports", 5, 60 * 60 * 1000), async (req, res, next) => {
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

app.get("/api/admin/me", auth, (req, res) => {
  res.json({ admin: isAdminUser(req.user) });
});

app.get("/api/admin/reports", auth, adminAuth, async (req, res, next) => {
  try {
    const status = ["pending", "resolved", "dismissed"].includes(String(req.query.status))
      ? String(req.query.status) : "pending";
    const { rows } = await pool.query(
      `SELECT r.id, r.reporter_id, r.reported_id, r.reason, r.details,
              r.status, r.created_at,
              COALESCE(reporter.display_name, 'Utilisateur') AS reporter_name,
              COALESCE(reported.display_name, 'Utilisateur') AS reported_name,
              s.suspended_until,
              (s.user_id IS NOT NULL AND (s.suspended_until IS NULL OR s.suspended_until > NOW())) AS suspended
       FROM letchat_reports r
       LEFT JOIN profiles reporter ON reporter.user_id = r.reporter_id
       LEFT JOIN profiles reported ON reported.user_id = r.reported_id
       LEFT JOIN letchat_suspensions s ON s.user_id = r.reported_id
       WHERE r.status = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [status]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/reports/:id", auth, adminAuth, async (req, res, next) => {
  try {
    const status = String(req.body.status || "");
    if (!["pending", "resolved", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "Statut incorrect" });
    }
    const result = await pool.query(
      "UPDATE letchat_reports SET status=$1 WHERE id=$2 RETURNING id, status, reporter_id, reported_id",
      [status, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Signalement introuvable" });
    await createNotification(
      result.rows[0].reporter_id, "report_update", "Mise à jour de votre signalement",
      status === "resolved" ? "Votre signalement a été traité par la modération." : "Votre signalement a été examiné et classé.",
      null, String(result.rows[0].id)
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/suspensions/:userId", auth, adminAuth, async (req, res, next) => {
  try {
    const userId = String(req.params.userId || "").slice(0, 200);
    const duration = String(req.body.duration || "24h");
    const reason = String(req.body.reason || "Signalement traité par la modération").trim().slice(0, 500);
    if (!userId || userId === req.user.id) {
      return res.status(400).json({ error: "Compte incorrect" });
    }
    const intervals = { "24h": "1 day", "7d": "7 days" };
    if (!["24h", "7d", "permanent"].includes(duration)) {
      return res.status(400).json({ error: "Durée incorrecte" });
    }
    const until = duration === "permanent" ? null : intervals[duration];
    await pool.query(
      `INSERT INTO letchat_suspensions (user_id, suspended_until, reason, updated_by)
       VALUES ($1, CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() + $2::interval END, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         suspended_until=EXCLUDED.suspended_until, reason=EXCLUDED.reason,
         updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [userId, until, reason, req.user.id]
    );
    for (const [socketId, entry] of online) {
      if (entry.user.id === userId) io.sockets.sockets.get(socketId)?.disconnect(true);
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/suspensions/:userId", auth, adminAuth, async (req, res, next) => {
  try {
    await pool.query("DELETE FROM letchat_suspensions WHERE user_id=$1", [String(req.params.userId)]);
    res.json({ ok: true });
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

app.get("/api/messages", auth, requireAdult, async (req, res, next) => {
  try {
    const room = getRoom(req.query.room);
    const { rows } = await pool.query(`
      SELECT m.id, m.user_id, m.author, m.room, m.photo, m.body, m.media_type,
             m.created_at, m.expires_at, m.reply_to_id,
             parent.author AS reply_author, parent.body AS reply_body,
             (m.media_data IS NOT NULL) AS has_media,
             COALESCE((SELECT jsonb_object_agg(x.emoji, x.total) FROM (
               SELECT emoji, COUNT(*)::int AS total
               FROM letchat_message_reactions
               WHERE message_kind='public' AND message_id=m.id GROUP BY emoji
             ) x), '{}'::jsonb) AS reactions,
             COALESCE((SELECT jsonb_agg(emoji) FROM letchat_message_reactions
               WHERE message_kind='public' AND message_id=m.id AND user_id=$2), '[]'::jsonb) AS my_reactions
      FROM letchat_messages m
      LEFT JOIN letchat_messages parent ON parent.id=m.reply_to_id AND parent.expires_at > NOW()
      WHERE m.expires_at > NOW() AND m.room = $1
        AND NOT EXISTS (
          SELECT 1 FROM letchat_blocks b
          WHERE b.blocker_id = $2 AND b.blocked_id = m.user_id
        )
      ORDER BY m.id DESC LIMIT 100
    `, [room, req.user.id]);
    res.json(rows.reverse());
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id", auth, requireAdult, async (req, res, next) => {
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

app.post("/api/messages", auth, requireAdult, requireRules, rateLimitAction("public-messages", 30, 60 * 1000), async (req, res, next) => {
  try {
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const room = getRoom(req.body.room);
    const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;
    const mediaType = String(req.body.mediaType || "");
    const media = req.body.mediaBase64
      ? Buffer.from(String(req.body.mediaBase64), "base64")
      : null;

    if (!body && !media) return res.status(400).json({ error: "Message vide" });
    if (media && media.length > 8e6) {
      return res.status(413).json({ error: "Fichier trop volumineux (8 Mo maximum)" });
    }
    if (media && !/^(image|video|audio)\//.test(mediaType)) {
      return res.status(415).json({ error: "Format non accepté" });
    }
    let reply = null;
    if (replyToId) {
      const result = await pool.query(
        "SELECT id, author, body FROM letchat_messages WHERE id=$1 AND room=$2 AND expires_at > NOW()",
        [replyToId, room]
      );
      if (!result.rowCount) return res.status(400).json({ error: "Message cité introuvable" });
      reply = result.rows[0];
    }

    const query = await pool.query(
      `INSERT INTO letchat_messages
       (user_id, author, room, photo, body, media_data, media_type, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, author, room, photo, body, media_type, created_at, expires_at, reply_to_id,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, req.user.name, room, req.user.photo, body, media, mediaType || null, reply?.id || null]
    );
    const message = { ...query.rows[0], reply_author: reply?.author || null, reply_body: reply?.body || null, reactions: {}, my_reactions: [] };
    io.to(room).emit("message", message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.get("/api/private/:otherId", auth, requireAdult, async (req, res, next) => {
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
      `SELECT m.id, m.sender_id AS user_id, m.recipient_id, m.sender_name AS author,
              m.sender_photo AS photo, m.body, m.media_type, m.created_at, m.expires_at,
              m.reply_to_id, parent.sender_name AS reply_author, parent.body AS reply_body,
              (m.media_data IS NOT NULL) AS has_media,
              COALESCE((SELECT jsonb_object_agg(x.emoji, x.total) FROM (
                SELECT emoji, COUNT(*)::int AS total
                FROM letchat_message_reactions
                WHERE message_kind='private' AND message_id=m.id GROUP BY emoji
              ) x), '{}'::jsonb) AS reactions,
              COALESCE((SELECT jsonb_agg(emoji) FROM letchat_message_reactions
                WHERE message_kind='private' AND message_id=m.id AND user_id=$1), '[]'::jsonb) AS my_reactions
       FROM letchat_private_messages m
       LEFT JOIN letchat_private_messages parent ON parent.id=m.reply_to_id AND parent.expires_at > NOW()
       WHERE m.expires_at > NOW()
         AND ((m.sender_id=$1 AND m.recipient_id=$2)
           OR (m.sender_id=$2 AND m.recipient_id=$1))
       ORDER BY m.id DESC LIMIT 100`,
      [req.user.id, otherId]
    );
    res.json(rows.reverse().map(row => ({ ...row, private: true })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/private-media/:id", auth, requireAdult, async (req, res, next) => {
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

app.post("/api/private", auth, requireAdult, requireRules, rateLimitAction("private-messages", 30, 60 * 1000), async (req, res, next) => {
  try {
    const recipientId = String(req.body.recipientId || "").slice(0, 200);
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;
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
    if (media && !/^(image|video|audio)\//.test(mediaType)) {
      return res.status(415).json({ error: "Format non accepté" });
    }
    let reply = null;
    if (replyToId) {
      const result = await pool.query(
        `SELECT id, sender_name AS author, body FROM letchat_private_messages
         WHERE id=$1 AND expires_at > NOW()
           AND ((sender_id=$2 AND recipient_id=$3) OR (sender_id=$3 AND recipient_id=$2))`,
        [replyToId, req.user.id, recipientId]
      );
      if (!result.rowCount) return res.status(400).json({ error: "Message cité introuvable" });
      reply = result.rows[0];
    }
    const { rows } = await pool.query(
      `INSERT INTO letchat_private_messages
       (sender_id,recipient_id,sender_name,sender_photo,body,media_data,media_type,reply_to_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, sender_id AS user_id, sender_name AS author,
                 sender_photo AS photo, body, media_type, created_at, expires_at, reply_to_id,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, recipientId, req.user.name, req.user.photo, body, media, mediaType || null, reply?.id || null]
    );
    const message = { ...rows[0], private: true, recipient_id: recipientId, reply_author: reply?.author || null, reply_body: reply?.body || null, reactions: {}, my_reactions: [] };
    await createNotification(
      recipientId, "private_message", `Message de ${req.user.name}`,
      body ? body.slice(0, 160) : "Vous avez reçu un média.",
      req.user.id, String(message.id)
    );
    io.to(`user:${req.user.id}`).to(`user:${recipientId}`).emit("private-message", message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

async function getMessageAccess(kind, id, userId) {
  if (kind === "public") {
    const result = await pool.query(
      "SELECT id, user_id, room FROM letchat_messages WHERE id=$1 AND expires_at > NOW()",
      [id]
    );
    return result.rows[0] || null;
  }
  if (kind === "private") {
    const result = await pool.query(
      `SELECT id, sender_id AS user_id, recipient_id
       FROM letchat_private_messages
       WHERE id=$1 AND expires_at > NOW() AND (sender_id=$2 OR recipient_id=$2)`,
      [id, userId]
    );
    return result.rows[0] || null;
  }
  return null;
}

async function getReactionCounts(kind, id) {
  const { rows } = await pool.query(
    `SELECT emoji, COUNT(*)::int AS total
     FROM letchat_message_reactions
     WHERE message_kind=$1 AND message_id=$2
     GROUP BY emoji`,
    [kind, id]
  );
  return Object.fromEntries(rows.map(row => [row.emoji, row.total]));
}

app.post("/api/messages/:kind/:id/reactions", auth, requireAdult, requireRules, rateLimitAction("message-reactions", 60, 60 * 1000), async (req, res, next) => {
  try {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const emoji = String(req.body.emoji || "");
    if (!new Set(["👍", "❤️", "😂", "😮"]).has(emoji)) {
      return res.status(400).json({ error: "Réaction incorrecte" });
    }
    const message = await getMessageAccess(kind, id, req.user.id);
    if (!message) return res.status(404).json({ error: "Message introuvable" });
    const removed = await pool.query(
      `DELETE FROM letchat_message_reactions
       WHERE message_kind=$1 AND message_id=$2 AND user_id=$3 AND emoji=$4
       RETURNING emoji`,
      [kind, id, req.user.id, emoji]
    );
    let active = false;
    if (!removed.rowCount) {
      await pool.query(
        `INSERT INTO letchat_message_reactions(message_kind,message_id,user_id,emoji)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [kind, id, req.user.id, emoji]
      );
      active = true;
    }
    const reactions = await getReactionCounts(kind, id);
    const payload = { id, private: kind === "private", reactions };
    if (kind === "public") io.to(message.room).emit("message-reactions", payload);
    else io.to(`user:${message.user_id}`).to(`user:${message.recipient_id}`).emit("message-reactions", payload);
    res.json({ ...payload, emoji, active });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/messages/:kind/:id", auth, requireAdult, async (req, res, next) => {
  try {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    let result;
    if (kind === "public") {
      result = await pool.query(
        "DELETE FROM letchat_messages WHERE id=$1 AND user_id=$2 RETURNING room",
        [id, req.user.id]
      );
    } else if (kind === "private") {
      result = await pool.query(
        `DELETE FROM letchat_private_messages WHERE id=$1 AND sender_id=$2
         RETURNING sender_id AS user_id, recipient_id`,
        [id, req.user.id]
      );
    } else {
      return res.status(400).json({ error: "Type de message incorrect" });
    }
    if (!result.rowCount) return res.status(404).json({ error: "Message introuvable ou suppression interdite" });
    await pool.query(
      "DELETE FROM letchat_message_reactions WHERE message_kind=$1 AND message_id=$2",
      [kind, id]
    );
    const payload = { id, private: kind === "private" };
    if (kind === "public") io.to(result.rows[0].room).emit("message-deleted", payload);
    else io.to(`user:${result.rows[0].user_id}`).to(`user:${result.rows[0].recipient_id}`).emit("message-deleted", payload);
    res.json({ ok: true });
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
    const ageConsent = await pool.query(
      "SELECT 1 FROM letchat_age_consents WHERE user_id=$1 AND over_18=TRUE",
      [socket.user.id]
    );
    if (!ageConsent.rowCount) return next(new Error("age-required"));
    if (!isAdminUser(socket.user)) {
      const suspension = await pool.query(
        `SELECT 1 FROM letchat_suspensions
         WHERE user_id=$1 AND (suspended_until IS NULL OR suspended_until > NOW())`,
        [socket.user.id]
      );
      if (suspension.rowCount) return next(new Error("suspended"));
    }
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
    const bucketCutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, times] of actionBuckets) {
      const active = times.filter(time => time > bucketCutoff);
      if (active.length) actionBuckets.set(key, active);
      else actionBuckets.delete(key);
    }
    await pool.query(
      "DELETE FROM letchat_notifications WHERE created_at <= NOW() - INTERVAL '30 days'"
    );
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
    await pool.query(`
      DELETE FROM letchat_message_reactions r
      WHERE (r.message_kind='public' AND NOT EXISTS (
        SELECT 1 FROM letchat_messages m WHERE m.id=r.message_id
      )) OR (r.message_kind='private' AND NOT EXISTS (
        SELECT 1 FROM letchat_private_messages p WHERE p.id=r.message_id
      ))
    `);
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
