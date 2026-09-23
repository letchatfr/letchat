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
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'available';
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS private_message_policy TEXT NOT NULL DEFAULT 'everyone';
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
  ALTER TABLE letchat_private_messages
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
  ALTER TABLE letchat_private_messages
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
  ALTER TABLE letchat_private_messages
  ADD COLUMN IF NOT EXISTS view_once BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE letchat_private_messages
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
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
  CREATE TABLE IF NOT EXISTS letchat_conversation_preferences (
    user_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    muted BOOLEAN NOT NULL DEFAULT FALSE,
    hidden_before TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, other_id),
    CHECK (user_id <> other_id)
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_conversation_preferences_user
  ON letchat_conversation_preferences(user_id, archived, updated_at DESC);
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
  ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS message_kind TEXT;
  ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE letchat_reports ADD COLUMN IF NOT EXISTS evidence_body TEXT NOT NULL DEFAULT '';
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
  CREATE TABLE IF NOT EXISTS letchat_moderation_log (
    id BIGSERIAL PRIMARY KEY,
    admin_id TEXT NOT NULL,
    admin_name TEXT NOT NULL DEFAULT 'Administrateur',
    action TEXT NOT NULL,
    target_user_id TEXT,
    report_id BIGINT,
    details TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_moderation_log_created
  ON letchat_moderation_log(created_at DESC);
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

const MESSAGE_SPAM_WINDOW_MS = 2 * 60 * 1000;
const MAX_LINKS_PER_MESSAGE = 4;

function normalizedMessageBody(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("fr")
    .replace(/\s+/g, " ")
    .trim();
}

function messageLinkCount(value) {
  return (String(value || "").match(/(?:https?:\/\/|www\.)[^\s]+/gi) || []).length;
}

function validateMessageContent(body) {
  if (messageLinkCount(body) > MAX_LINKS_PER_MESSAGE) {
    return "Trop de liens dans ce message (4 maximum)";
  }
  if (/(?:javascript|data|vbscript)\s*:/i.test(body)) {
    return "Ce type de lien n’est pas autorisé";
  }
  if (/(.)\1{39,}/u.test(body)) {
    return "Ce message contient trop de caractères répétés";
  }
  return null;
}

async function isRepeatedMessage({ userId, body, recipientId = null }) {
  const normalized = normalizedMessageBody(body);
  if (normalized.length < 2) return false;
  const intervalSeconds = Math.ceil(MESSAGE_SPAM_WINDOW_MS / 1000);
  const query = recipientId
    ? await pool.query(
        `SELECT body FROM letchat_private_messages
         WHERE sender_id=$1 AND recipient_id=$2
           AND created_at > NOW() - ($3 * INTERVAL '1 second')
           AND body IS NOT NULL AND body <> ''
         ORDER BY created_at DESC LIMIT 8`,
        [userId, recipientId, intervalSeconds]
      )
    : await pool.query(
        `SELECT body FROM letchat_messages
         WHERE user_id=$1
           AND created_at > NOW() - ($2 * INTERVAL '1 second')
           AND body IS NOT NULL AND body <> ''
         ORDER BY created_at DESC LIMIT 8`,
        [userId, intervalSeconds]
      );
  return query.rows.filter(row => normalizedMessageBody(row.body) === normalized).length >= 2;
}

async function rejectSpamMessage(req, res, body, recipientId = null) {
  const contentError = validateMessageContent(body);
  if (contentError) {
    res.status(400).json({ error: contentError });
    return true;
  }
  if (await isRepeatedMessage({ userId: req.user.id, body, recipientId })) {
    res.status(429).json({
      error: "Message répété détecté. Modifiez votre texte ou attendez deux minutes"
    });
    return true;
  }
  return false;
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
    const [profile, publicMessages, privateMessages, friends, blocks, notifications, reports, consents, conversationPreferences] = await Promise.all([
      pool.query("SELECT user_id,email,display_name,photo,city,bio,gender,availability,last_seen,location_visible,updated_at FROM profiles WHERE user_id=$1", [uid]),
      pool.query("SELECT id,author,room,body,media_type,created_at,expires_at FROM letchat_messages WHERE user_id=$1 ORDER BY created_at", [uid]),
      pool.query(`SELECT id,sender_id,recipient_id,sender_name,body,media_type,view_once,opened_at,created_at,expires_at
                  FROM letchat_private_messages WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at`, [uid]),
      pool.query("SELECT id,requester_id,addressee_id,status,created_at,updated_at FROM letchat_friends WHERE requester_id=$1 OR addressee_id=$1", [uid]),
      pool.query("SELECT blocker_id,blocked_id,created_at FROM letchat_blocks WHERE blocker_id=$1 OR blocked_id=$1", [uid]),
      pool.query("SELECT id,type,title,body,actor_id,reference_id,read_at,created_at FROM letchat_notifications WHERE user_id=$1 ORDER BY created_at", [uid]),
      pool.query("SELECT id,reporter_id,reported_id,reason,details,status,created_at FROM letchat_reports WHERE reporter_id=$1 OR reported_id=$1 ORDER BY created_at", [uid]),
      pool.query(`SELECT 'rules' AS type,rules_version AS version,accepted_at FROM letchat_consents WHERE user_id=$1
                  UNION ALL SELECT 'age','18+',accepted_at FROM letchat_age_consents WHERE user_id=$1`, [uid]),
      pool.query("SELECT other_id,archived,muted,hidden_before,updated_at FROM letchat_conversation_preferences WHERE user_id=$1", [uid])
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
      conversationPreferences: conversationPreferences.rows,
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
    await client.query("DELETE FROM letchat_conversation_preferences WHERE user_id=$1 OR other_id=$1", [uid]);
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
      "SELECT display_name, photo, city, bio, gender, availability, last_seen, location_visible, private_message_policy FROM profiles WHERE user_id = $1",
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
    const availability = ["available", "busy", "away"].includes(String(req.body.availability)) ? String(req.body.availability) : "available";
    const privateMessagePolicy = ["everyone", "friends", "nobody"].includes(String(req.body.privateMessagePolicy))
      ? String(req.body.privateMessagePolicy) : "everyone";
    const photoData = String(req.body.photoData || "");
    if (photoData && (!/^data:image\/(jpeg|png|webp);base64,/i.test(photoData) || photoData.length > 2100000)) {
      return res.status(400).json({ error: "Photo incorrecte ou trop volumineuse" });
    }
    const photo = photoData || req.user.photo || "";
    const locationVisible = req.body.locationVisible !== false;
    if (!city) {
      return res.status(400).json({ error: "Ville obligatoire" });
    }
    const { rows } = await pool.query(
      `INSERT INTO profiles
       (user_id, email, display_name, photo, region, department, city, bio, gender, availability, location_visible, private_message_policy, last_seen)
       VALUES ($1,$2,$3,$4,'','',$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         email=EXCLUDED.email, display_name=EXCLUDED.display_name,
         photo=EXCLUDED.photo, region='',
         department='', city=EXCLUDED.city, bio=EXCLUDED.bio, gender=EXCLUDED.gender,
         availability=EXCLUDED.availability,
         location_visible=EXCLUDED.location_visible,
         private_message_policy=EXCLUDED.private_message_policy, updated_at=NOW()
       RETURNING display_name, photo, city, bio, gender, availability, last_seen, location_visible, private_message_policy`,
      [req.user.id, req.user.email, displayName, photo, city, bio, gender, availability, locationVisible, privateMessagePolicy]
    );
    for (const [socketId, entry] of online) {
      if (entry.user.id === req.user.id) {
        entry.user.profile = rows[0];
        entry.user.name = rows[0].display_name;
        entry.user.photo = rows[0].photo;
        online.set(socketId, entry);
        emitPresence(entry.room);
      }
    }
    emitPrivateStatus(req.user.id).catch(() => {});
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/profile/:userId", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, display_name, photo, bio, gender, availability, last_seen,
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
              p.photo, p.bio, p.gender, p.availability, p.last_seen
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

app.post("/api/reports", auth, requireAdult, requireRules, rateLimitAction("reports", 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    let reportedId = String(req.body.reportedId || "").slice(0, 200);
    const reason = String(req.body.reason || "");
    const details = String(req.body.details || "").trim().slice(0, 1000);
    const messageKind = ["public", "private"].includes(String(req.body.messageKind))
      ? String(req.body.messageKind) : null;
    const messageId = /^\d+$/.test(String(req.body.messageId || ""))
      ? String(req.body.messageId) : null;
    let evidenceBody = "";
    const allowedReasons = new Set(["harassment", "spam", "inappropriate", "fake", "other"]);
    if (messageKind && messageId) {
      const evidence = messageKind === "public"
        ? await pool.query(
            `SELECT user_id AS author_id, LEFT(COALESCE(NULLIF(body,''), '[Média]'), 2000) AS body
             FROM letchat_messages WHERE id=$1 AND expires_at > NOW()`, [messageId]
          )
        : await pool.query(
            `SELECT sender_id AS author_id, LEFT(COALESCE(NULLIF(body,''), '[Média]'), 2000) AS body
             FROM letchat_private_messages
             WHERE id=$1 AND expires_at > NOW() AND (sender_id=$2 OR recipient_id=$2)`,
            [messageId, req.user.id]
          );
      if (!evidence.rowCount) return res.status(404).json({ error: "Message à signaler introuvable" });
      reportedId = evidence.rows[0].author_id;
      evidenceBody = evidence.rows[0].body;
    }
    if (!reportedId || reportedId === req.user.id) {
      return res.status(400).json({ error: "Utilisateur incorrect" });
    }
    if (!allowedReasons.has(reason)) {
      return res.status(400).json({ error: "Motif de signalement incorrect" });
    }
    const recent = await pool.query(
      `SELECT 1 FROM letchat_reports
       WHERE reporter_id=$1 AND reported_id=$2
         AND (($3::bigint IS NULL AND message_id IS NULL) OR message_id=$3)
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [req.user.id, reportedId, messageId]
    );
    if (recent.rowCount) {
      return res.status(429).json({ error: "Vous avez déjà signalé cet utilisateur récemment" });
    }
    await pool.query(
      `INSERT INTO letchat_reports
         (reporter_id, reported_id, reason, details, message_kind, message_id, evidence_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, reportedId, reason, details, messageKind, messageId, evidenceBody]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/me", auth, (req, res) => {
  res.json({ admin: isAdminUser(req.user) });
});

async function logModerationAction(req, action, { targetUserId = null, reportId = null, details = "" } = {}) {
  await pool.query(
    `INSERT INTO letchat_moderation_log
       (admin_id, admin_name, action, target_user_id, report_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.id, req.user.name || "Administrateur", action, targetUserId, reportId, String(details || "").slice(0, 1000)]
  );
}

app.get("/api/admin/moderation-log", auth, adminAuth, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.admin_id, l.admin_name, l.action, l.target_user_id,
              l.report_id, l.details, l.created_at,
              COALESCE(p.display_name, CASE WHEN l.target_user_id IS NULL THEN NULL ELSE 'Utilisateur' END) AS target_name
       FROM letchat_moderation_log l
       LEFT JOIN profiles p ON p.user_id=l.target_user_id
       ORDER BY l.created_at DESC
       LIMIT 300`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/reports", auth, adminAuth, async (req, res, next) => {
  try {
    const status = ["pending", "resolved", "dismissed"].includes(String(req.query.status))
      ? String(req.query.status) : "pending";
    const { rows } = await pool.query(
      `SELECT r.id, r.reporter_id, r.reported_id, r.reason, r.details,
              r.message_kind, r.message_id, r.evidence_body,
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
    await logModerationAction(req, status === "resolved" ? "report_resolved" : status === "dismissed" ? "report_dismissed" : "report_reopened", {
      targetUserId: result.rows[0].reported_id,
      reportId: result.rows[0].id,
      details: `Statut du signalement : ${status}`
    });
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

app.delete("/api/admin/reports/:id/message", auth, adminAuth, async (req, res, next) => {
  try {
    const report = await pool.query(
      "SELECT message_kind, message_id, reported_id FROM letchat_reports WHERE id=$1",
      [req.params.id]
    );
    if (!report.rowCount || !report.rows[0].message_kind || !report.rows[0].message_id) {
      return res.status(404).json({ error: "Message signalé introuvable" });
    }
    const { message_kind: kind, message_id: id } = report.rows[0];
    let deleted;
    if (kind === "public") {
      deleted = await pool.query("DELETE FROM letchat_messages WHERE id=$1 RETURNING room", [id]);
    } else {
      deleted = await pool.query(
        `DELETE FROM letchat_private_messages WHERE id=$1
         RETURNING sender_id AS user_id, recipient_id`, [id]
      );
    }
    await pool.query(
      "DELETE FROM letchat_message_reactions WHERE message_kind=$1 AND message_id=$2",
      [kind, id]
    );
    if (deleted.rowCount) {
      const payload = { id: String(id), private: kind === "private" };
      if (kind === "public") io.to(deleted.rows[0].room).emit("message-deleted", payload);
      else io.to(`user:${deleted.rows[0].user_id}`).to(`user:${deleted.rows[0].recipient_id}`).emit("message-deleted", payload);
      await logModerationAction(req, "message_deleted", {
        targetUserId: report.rows[0].reported_id,
        reportId: req.params.id,
        details: `${kind === "private" ? "Message privé" : "Message public"} n°${id} supprimé`
      });
    }
    res.json({ ok: true, alreadyDeleted: !deleted.rowCount });
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
    await logModerationAction(req, "user_suspended", {
      targetUserId: userId,
      details: `Durée : ${duration}. Motif : ${reason}`
    });
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
    const userId = String(req.params.userId || "").slice(0, 200);
    const result = await pool.query("DELETE FROM letchat_suspensions WHERE user_id=$1 RETURNING user_id", [userId]);
    if (result.rowCount) {
      await logModerationAction(req, "user_unsuspended", {
        targetUserId: userId,
        details: "Suspension levée"
      });
    }
    res.json({ ok: true, alreadyActive: !result.rowCount });
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
    const secretKey = String(
      process.env.METERED_SECRET_KEY || process.env.METERED_API_KEY || ""
    ).trim();
    const permanentApiKey = String(process.env.METERED_TURN_API_KEY || "").trim();
    if (!domain || (!secretKey && !permanentApiKey) || !/^[a-z0-9.-]+\.metered\.live$/i.test(domain)) {
      return res.status(503).json({ error: "Serveur vidéo non configuré" });
    }
    const apiKey = permanentApiKey || await getMeteredTurnApiKey(domain, secretKey);
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

app.post("/api/messages", auth, requireAdult, requireRules,
  rateLimitAction("public-message-burst", 8, 10 * 1000),
  rateLimitAction("public-messages", 30, 60 * 1000), async (req, res, next) => {
  try {
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const room = getRoom(req.body.room);
    const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;
    const mediaType = String(req.body.mediaType || "");
    const media = req.body.mediaBase64
      ? Buffer.from(String(req.body.mediaBase64), "base64")
      : null;

    if (!body && !media) return res.status(400).json({ error: "Message vide" });
    if (body && await rejectSpamMessage(req, res, body)) return;
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

app.get("/api/private-conversations", auth, requireAdult, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `WITH visible AS (
         SELECT m.*,
                CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END AS other_id
         FROM letchat_private_messages m
         LEFT JOIN letchat_conversation_preferences cp
           ON cp.user_id=$1
          AND cp.other_id=CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END
         WHERE m.expires_at > NOW() AND (m.sender_id=$1 OR m.recipient_id=$1)
           AND (cp.hidden_before IS NULL OR m.created_at > cp.hidden_before)
       ), latest AS (
         SELECT DISTINCT ON (other_id)
                other_id, id, sender_id, sender_name, sender_photo, body,
                media_type, created_at
         FROM visible
         ORDER BY other_id, created_at DESC, id DESC
       ), unread AS (
         SELECT sender_id AS other_id, COUNT(*)::int AS unread_count
         FROM letchat_private_messages m
         LEFT JOIN letchat_conversation_preferences cp
           ON cp.user_id=$1 AND cp.other_id=m.sender_id
         WHERE m.recipient_id=$1 AND m.read_at IS NULL AND m.expires_at > NOW()
           AND (cp.hidden_before IS NULL OR m.created_at > cp.hidden_before)
         GROUP BY sender_id
       )
       SELECT l.other_id AS user_id,
              COALESCE(p.display_name,
                CASE WHEN l.sender_id=l.other_id THEN l.sender_name ELSE 'Utilisateur' END
              ) AS display_name,
              COALESCE(p.photo,
                CASE WHEN l.sender_id=l.other_id THEN l.sender_photo ELSE NULL END
              ) AS photo,
              p.gender, p.availability,
              l.id AS last_message_id, l.sender_id AS last_sender_id,
              l.body AS last_body, l.media_type AS last_media_type,
              l.created_at AS last_message_at,
              COALESCE(u.unread_count, 0)::int AS unread_count,
              COALESCE(cp.archived, FALSE) AS archived,
              COALESCE(cp.muted, FALSE) AS muted
       FROM latest l
       LEFT JOIN profiles p ON p.user_id=l.other_id
       LEFT JOIN unread u ON u.other_id=l.other_id
       LEFT JOIN letchat_conversation_preferences cp
         ON cp.user_id=$1 AND cp.other_id=l.other_id
       WHERE NOT EXISTS (
         SELECT 1 FROM letchat_blocks b
         WHERE (b.blocker_id=$1 AND b.blocked_id=l.other_id)
            OR (b.blocker_id=l.other_id AND b.blocked_id=$1)
       )
       ORDER BY l.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/private-conversations/:otherId", auth, requireAdult, async (req, res, next) => {
  try {
    const otherId = String(req.params.otherId || "").slice(0, 200);
    if (!otherId || otherId === req.user.id) return res.status(400).json({ error: "Conversation incorrecte" });
    const archived = typeof req.body.archived === "boolean" ? req.body.archived : null;
    const muted = typeof req.body.muted === "boolean" ? req.body.muted : null;
    if (archived === null && muted === null) return res.status(400).json({ error: "Aucune modification" });
    const { rows } = await pool.query(
      `INSERT INTO letchat_conversation_preferences (user_id,other_id,archived,muted)
       VALUES($1,$2,COALESCE($3,FALSE),COALESCE($4,FALSE))
       ON CONFLICT (user_id,other_id) DO UPDATE SET
         archived=COALESCE($3,letchat_conversation_preferences.archived),
         muted=COALESCE($4,letchat_conversation_preferences.muted),
         updated_at=NOW()
       RETURNING archived, muted`,
      [req.user.id, otherId, archived, muted]
    );
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/private-conversations/:otherId", auth, requireAdult, async (req, res, next) => {
  try {
    const otherId = String(req.params.otherId || "").slice(0, 200);
    if (!otherId || otherId === req.user.id) return res.status(400).json({ error: "Conversation incorrecte" });
    await pool.query(
      `INSERT INTO letchat_conversation_preferences
       (user_id,other_id,archived,muted,hidden_before)
       VALUES($1,$2,FALSE,FALSE,NOW())
       ON CONFLICT (user_id,other_id) DO UPDATE SET
         archived=FALSE, muted=FALSE, hidden_before=NOW(), updated_at=NOW()`,
      [req.user.id, otherId]
    );
    res.sendStatus(204);
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
              m.delivered_at, m.read_at, m.view_once, m.opened_at,
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
         AND m.created_at > COALESCE((
           SELECT hidden_before FROM letchat_conversation_preferences
           WHERE user_id=$1 AND other_id=$2
         ), '-infinity'::timestamptz)
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT media_data, media_type, sender_id, recipient_id, view_once, opened_at
       FROM letchat_private_messages
       WHERE id=$1 AND expires_at > NOW()
         AND (sender_id=$2 OR recipient_id=$2)
       FOR UPDATE`,
      [req.params.id, req.user.id]
    );
    const media = rows[0];
    if (!media) {
      await client.query("ROLLBACK");
      return res.sendStatus(404);
    }
    if (!media.media_data) {
      await client.query("ROLLBACK");
      return res.status(media.view_once && media.opened_at ? 410 : 404).json({
        error: media.view_once ? "Ce média a déjà été ouvert" : "Média introuvable"
      });
    }
    let openedAt = media.opened_at;
    if (media.view_once && media.recipient_id === req.user.id) {
      openedAt = new Date();
      await client.query(
        `UPDATE letchat_private_messages
         SET opened_at=$2, media_data=NULL
         WHERE id=$1`,
        [req.params.id, openedAt]
      );
    }
    await client.query("COMMIT");
    if (openedAt) res.set("X-Letchat-Opened-At", new Date(openedAt).toISOString());
    res.type(media.media_type)
      .set("Cache-Control", "private, no-store, max-age=0")
      .send(media.media_data);
    if (media.view_once && media.recipient_id === req.user.id) {
      io.to(`user:${media.sender_id}`).emit("view-once-opened", {
        id: String(req.params.id), opened_at: new Date(openedAt).toISOString()
      });
    }
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/private", auth, requireAdult, requireRules,
  rateLimitAction("private-message-burst", 8, 10 * 1000),
  rateLimitAction("private-messages", 30, 60 * 1000), async (req, res, next) => {
  try {
    const recipientId = String(req.body.recipientId || "").slice(0, 200);
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;
    const mediaType = String(req.body.mediaType || "");
    const viewOnce = req.body.viewOnce === true;
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
    const recipientProfile = await pool.query(
      "SELECT private_message_policy FROM profiles WHERE user_id=$1",
      [recipientId]
    );
    const privateMessagePolicy = recipientProfile.rows[0]?.private_message_policy || "everyone";
    if (privateMessagePolicy === "nobody") {
      return res.status(403).json({ error: "Cet utilisateur n’accepte pas les messages privés" });
    }
    if (privateMessagePolicy === "friends") {
      const friendship = await pool.query(
        `SELECT 1 FROM letchat_friends
         WHERE status='accepted'
           AND ((requester_id=$1 AND addressee_id=$2)
             OR (requester_id=$2 AND addressee_id=$1))
         LIMIT 1`,
        [req.user.id, recipientId]
      );
      if (!friendship.rowCount) {
        return res.status(403).json({ error: "Cet utilisateur accepte uniquement les messages de ses amis" });
      }
    }
    if (!body && !media) return res.status(400).json({ error: "Message vide" });
    if (body && await rejectSpamMessage(req, res, body, recipientId)) return;
    if (media && media.length > 8e6) {
      return res.status(413).json({ error: "Fichier trop volumineux (8 Mo maximum)" });
    }
    if (media && !/^(image|video|audio)\//.test(mediaType)) {
      return res.status(415).json({ error: "Format non accepté" });
    }
    if (viewOnce && (!media || !/^(image|video)\//.test(mediaType))) {
      return res.status(400).json({ error: "Le mode visible une fois est réservé aux photos et vidéos" });
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
       (sender_id,recipient_id,sender_name,sender_photo,body,media_data,media_type,reply_to_id,view_once)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, sender_id AS user_id, sender_name AS author,
                 sender_photo AS photo, body, media_type, created_at, expires_at, reply_to_id,
                 delivered_at, read_at, view_once, opened_at,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, recipientId, req.user.name, req.user.photo, body, media, mediaType || null, reply?.id || null, viewOnce]
    );
    const message = { ...rows[0], private: true, recipient_id: recipientId, reply_author: reply?.author || null, reply_body: reply?.body || null, reactions: {}, my_reactions: [] };
    await pool.query(
      `INSERT INTO letchat_conversation_preferences (user_id,other_id,archived)
       VALUES ($1,$2,FALSE),($2,$1,FALSE)
       ON CONFLICT (user_id,other_id) DO UPDATE SET archived=FALSE, updated_at=NOW()`,
      [req.user.id, recipientId]
    );
    const recipientPreference = await pool.query(
      "SELECT muted FROM letchat_conversation_preferences WHERE user_id=$1 AND other_id=$2",
      [recipientId, req.user.id]
    );
    if (!recipientPreference.rows[0]?.muted) {
      await createNotification(
        recipientId, "private_message", `Message de ${req.user.name}`,
        body ? body.slice(0, 160) : "Vous avez reçu un média.",
        req.user.id, String(message.id)
      );
    }
    io.to(`user:${req.user.id}`).to(`user:${recipientId}`).emit("private-message", message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/private/:otherId/delivered", auth, requireAdult, async (req, res, next) => {
  try {
    const otherId = String(req.params.otherId || "").slice(0, 200);
    const { rows } = await pool.query(
      `UPDATE letchat_private_messages
       SET delivered_at=COALESCE(delivered_at,NOW())
       WHERE sender_id=$1 AND recipient_id=$2 AND delivered_at IS NULL AND expires_at > NOW()
       RETURNING id, delivered_at, read_at`,
      [otherId, req.user.id]
    );
    if (rows.length) io.to(`user:${otherId}`).emit("private-receipt", { messages: rows });
    res.json({ messages: rows });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/private/:otherId/read", auth, requireAdult, async (req, res, next) => {
  try {
    const otherId = String(req.params.otherId || "").slice(0, 200);
    const { rows } = await pool.query(
      `UPDATE letchat_private_messages
       SET delivered_at=COALESCE(delivered_at,NOW()), read_at=COALESCE(read_at,NOW())
       WHERE sender_id=$1 AND recipient_id=$2 AND read_at IS NULL AND expires_at > NOW()
       RETURNING id, delivered_at, read_at`,
      [otherId, req.user.id]
    );
    if (rows.length) io.to(`user:${otherId}`).emit("private-receipt", { messages: rows });
    res.json({ messages: rows });
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

function userIsOnline(userId) {
  return [...online.values()].some(entry => entry.user.id === userId);
}

async function getPrivateStatus(userId) {
  const active = [...online.values()].find(entry => entry.user.id === userId);
  if (active) {
    return {
      userId,
      online: true,
      availability: active.user.profile?.availability || "available",
      lastSeen: new Date().toISOString()
    };
  }
  const { rows } = await pool.query(
    "SELECT availability,last_seen FROM profiles WHERE user_id=$1",
    [userId]
  );
  return { userId, online: false, availability: rows[0]?.availability || "available", lastSeen: rows[0]?.last_seen || null };
}

async function emitPrivateStatus(userId) {
  io.to(`watch-status:${userId}`).emit("private-status", await getPrivateStatus(userId));
}

function emitPresence(room) {
  const people = [...online.values()]
    .filter(entry => entry.room === room)
    .map(entry => ({
      id: entry.user.id,
      name: entry.user.name,
      photo: entry.user.photo,
      bio: entry.user.profile?.bio || "",
      gender: entry.user.profile?.gender || "neutral",
      availability: entry.user.profile?.availability || "available",
      last_seen: entry.user.profile?.last_seen || null,
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
      "SELECT display_name, photo, city, bio, gender, availability, last_seen, location_visible FROM profiles WHERE user_id = $1",
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
  pool.query("UPDATE profiles SET last_seen=NOW() WHERE user_id=$1", [socket.user.id]).catch(() => {});
  socket.join(`user:${socket.user.id}`);
  socket.room = "cafe";
  socket.join(socket.room);
  online.set(socket.id, { user: socket.user, room: socket.room });
  emitPresence(socket.room);
  emitPrivateStatus(socket.user.id).catch(() => {});

  socket.on("watch-private-status", async value => {
    const target = String(value || "").slice(0, 200);
    if (socket.watchedStatusUser) socket.leave(`watch-status:${socket.watchedStatusUser}`);
    socket.watchedStatusUser = null;
    if (!target || target === socket.user.id) return;
    socket.watchedStatusUser = target;
    socket.join(`watch-status:${target}`);
    try { socket.emit("private-status", await getPrivateStatus(target)); } catch {}
  });

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

  socket.on("private-typing", async payload => {
    const target = String(payload?.target || "").slice(0, 200);
    const active = Boolean(payload?.active);
    if (!target || target === socket.user.id) return;
    const sequence = (socket.privateTypingSequence || 0) + 1;
    socket.privateTypingSequence = sequence;
    if (active) {
      const blocked = await pool.query(
        `SELECT 1 FROM letchat_blocks
         WHERE (blocker_id=$1 AND blocked_id=$2)
            OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
        [socket.user.id, target]
      ).catch(() => ({ rowCount: 1 }));
      if (socket.privateTypingSequence !== sequence) return;
      if (blocked.rowCount) return;
      socket.privateTypingTarget = target;
    } else if (socket.privateTypingTarget === target) {
      socket.privateTypingTarget = null;
    }
    io.to(`user:${target}`).emit("private-typing", {
      userId: socket.user.id,
      name: socket.user.name,
      active
    });
  });

  socket.on("webrtc", ({ target, data }) => {
    const signal = { from: socket.id, user: socket.user, data };
    if (target) io.to(target).emit("webrtc", signal);
    else socket.to(socket.room).emit("webrtc", signal);
  });

  socket.on("disconnect", async () => {
    const room = socket.room;
    if (socket.privateTypingTarget) {
      io.to(`user:${socket.privateTypingTarget}`).emit("private-typing", {
        userId: socket.user.id,
        name: socket.user.name,
        active: false
      });
    }
    online.delete(socket.id);
    if (!userIsOnline(socket.user.id)) {
      await pool.query("UPDATE profiles SET last_seen=NOW() WHERE user_id=$1", [socket.user.id]).catch(() => {});
      await emitPrivateStatus(socket.user.id).catch(() => {});
    }
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
