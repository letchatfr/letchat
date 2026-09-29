import { installAdmin } from "./lib/admin.js";
import { installSurprise } from "./lib/surprise.js";
import { installSocial } from "./lib/social.js";
import { installPremiumBenefits } from "./lib/premium-benefits.js";
import { rooms as roomCatalog } from "./public/room-catalog.js";
import express from "express";
import { validateMedia, serveMedia } from "./lib/media.js";
import { CallRegistry } from "./lib/calls.js";
import { createCheckout, withBillingQueue } from "./lib/checkout.js";
import { newRecoveryCode, recoveryHash, installRecoveryRoutes, purgeExpiredGuests } from "./lib/accounts.js";
import { installAdvertisingPage } from "./lib/advertising.js";
import helmet from "helmet";
import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { passwordDigest, matchesPassword } from "./lib/passwords.js";
import pg from "pg";
import { Server } from "socket.io";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import Stripe from "stripe";
import webpush from "web-push";
import { validatePushSubscription, sendValidatedPush, MAX_PUSH_SUBSCRIPTIONS } from "./lib/push-security.js";

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100000 });
const projectId = process.env.FIREBASE_PROJECT_ID || "letchat-1d79d";
const jwtSecret = String(process.env.JWT_SECRET || "").trim();
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET doit être défini avec au moins 32 caractères avant le démarrage de Letchat");
}
const localJwtSecret = new TextEncoder().encode(jwtSecret);
const port = process.env.PORT || 10000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const premiumPrices = { premium: process.env.STRIPE_PRICE_ID, premium_plus: process.env.STRIPE_PRICE_PLUS_ID };
const premiumLabel = { premium: "Premium", premium_plus: "Premium+" };
function planFromPrice(priceId) {
  return Object.keys(premiumPrices).find(plan => premiumPrices[plan] && premiumPrices[plan] === priceId) || null;
}
async function saveStripeSubscription(subscription, fallbackUserId = "", allowReplacement = false) {
  const userId = String(subscription.metadata?.userId || fallbackUserId);
  if (!userId || !subscription.customer) return;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planFromPrice(priceId) || (premiumLabel[subscription.metadata?.plan] ? subscription.metadata.plan : null);
  const end = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
  await pool.query(
    `INSERT INTO letchat_subscriptions
     (user_id,email,stripe_customer_id,stripe_subscription_id,status,current_period_end,plan,updated_at)
     VALUES ($1,'',$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id=EXCLUDED.stripe_customer_id,
       stripe_subscription_id=EXCLUDED.stripe_subscription_id,
       status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,
       plan=EXCLUDED.plan,updated_at=NOW()
     WHERE letchat_subscriptions.stripe_subscription_id=EXCLUDED.stripe_subscription_id
       OR ($7 AND letchat_subscriptions.stripe_customer_id=EXCLUDED.stripe_customer_id
         AND letchat_subscriptions.status IN ('free','canceled','incomplete_expired'))`,
    [userId, String(subscription.customer), subscription.id, subscription.status,
      end ? new Date(end * 1000) : null, plan || "premium", allowReplacement]
  );
  if (!["active", "trialing"].includes(subscription.status))
    await moveExpiredPremiumSockets(userId);
}
const vapidPublicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushConfigured) {
  webpush.setVapidDetails(
    `mailto:${String(process.env.CONTACT_EMAIL || "contact@letchat.fr").trim()}`,
    vapidPublicKey,
    vapidPrivateKey
  );
}

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
  ALTER TABLE letchat_messages
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
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
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS letchat_local_accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    is_guest BOOLEAN NOT NULL DEFAULT FALSE,
    gender TEXT NOT NULL DEFAULT 'neutral',
    city TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_local_accounts_expiry ON letchat_local_accounts(expires_at);
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
  CREATE TABLE IF NOT EXISTS letchat_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_letchat_push_user
  ON letchat_push_subscriptions(user_id);
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

await pool.query(`
  ALTER TABLE letchat_local_accounts ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE letchat_local_accounts ADD COLUMN IF NOT EXISTS recovery_hash TEXT;
  CREATE TABLE IF NOT EXISTS letchat_session_revocations (
    user_id TEXT PRIMARY KEY, revoked_before TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS letchat_billing_accounts (
    user_id TEXT PRIMARY KEY, stripe_customer_id TEXT UNIQUE,
    checkout_key TEXT, checkout_plan TEXT, checkout_params JSONB,
    checkout_session_id TEXT, checkout_started_at TIMESTAMPTZ
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

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
            "default-src": ["'self'"],
      "script-src": [
        "'self'",
        "https://www.gstatic.com",
        "https://www.googleapis.com",
        "https://apis.google.com"
      ],
      "script-src-attr": ["'none'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:", "https://*.googleusercontent.com"],
      "media-src": ["'self'", "blob:"],
      "connect-src": ["'self'", "wss://www.letchat.fr", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com"],
      "frame-src": ["'self'", "https://letchat-1d79d.firebaseapp.com", "https://accounts.google.com"],
      "object-src": ["'none'"], "base-uri": ["'self'"], "form-action": ["'self'"],
      "frame-ancestors": ["'none'"], "upgrade-insecure-requests": process.env.NODE_ENV === "production" ? [] : null
    }
  },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
});
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
      if (userId && session.mode === "subscription" && session.subscription &&
          session.payment_status !== "unpaid") {
        const subscription = await stripe.subscriptions.retrieve(String(session.subscription));
        await saveStripeSubscription(subscription, userId, true);
      }
    }
    if (["customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const received = event.data.object;
      const subscription = event.type === "customer.subscription.deleted"
        ? received : await stripe.subscriptions.retrieve(received.id);
      const known = await pool.query("SELECT user_id FROM letchat_subscriptions WHERE stripe_subscription_id=$1", [subscription.id]);
      await saveStripeSubscription(subscription, known.rows[0]?.user_id);
    }
    res.json({ received: true });
  } catch (error) {
    console.error("Webhook Stripe :", error.message);
    res.status(400).send("Webhook incorrect");
  }
});
app.use(express.json({ limit: "12mb" }));
const ipBuckets = new Map();
app.use("/api", (req, res, next) => {
  const key = createHash("sha256").update(String(req.ip || req.socket.remoteAddress || "unknown")).digest("hex");
  const now = Date.now(), windowMs = 5 * 60 * 1000, maximum = 500;
  const recent = (ipBuckets.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= maximum) {
    const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    res.set("Retry-After", String(retrySeconds));
    return res.status(429).json({ error: `Trop de requêtes depuis cette connexion. Réessayez dans ${retrySeconds} secondes` });
  }
  recent.push(now);
  ipBuckets.set(key, recent);
  next();
});
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
app.get("/privacy.html", (_req, res) => res.redirect(301, "/confidentialite.html"));
await installAdvertisingPage(app);
app.use(express.static("public", {
  etag: true, lastModified: true,
  setHeaders(res, filePath) {
    // Fingerprinted build assets only; HTML, unversioned code and SW revalidate.
    const immutable = /[/\\]assets[/\\].*\.[a-f0-9]{12}\.(?:js|css|svg|ico|png)$/.test(filePath);
    res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
  }
}));

async function verify(token) {
  try {
    const { payload } = await jwtVerify(token, localJwtSecret, { issuer: "letchat-local", audience: "letchat" });
    const account = await pool.query(
      `SELECT username,is_guest,expires_at,session_version FROM letchat_local_accounts
       WHERE user_id=$1 AND (expires_at IS NULL OR expires_at > NOW())`, [String(payload.sub)]
    );
    if (!account.rowCount || Number(payload.ver || 0) !== account.rows[0].session_version) throw new Error("Session locale expirée");
    return { id: String(payload.sub), email: "", name: account.rows[0].username, loginUsername: account.rows[0].username, photo: null, local: true, guest: account.rows[0].is_guest, expiresAt: Math.min(Number(payload.exp) * 1000, account.rows[0].expires_at ? new Date(account.rows[0].expires_at).getTime() : Infinity) };
  } catch (localError) {
    if (localError.message === "Session locale expirée") throw localError;
  }
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId });
  const revoked = await pool.query("SELECT revoked_before FROM letchat_session_revocations WHERE user_id=$1", [String(payload.sub)]);
  if (revoked.rowCount && Number(payload.auth_time || payload.iat) * 1000 <= new Date(revoked.rows[0].revoked_before).getTime()) throw new Error("Session révoquée");
  return {
    expiresAt: Number(payload.exp) * 1000,
    id: String(payload.sub),
    email: String(payload.email || ""),
    name: String(payload.name || payload.email || "Utilisateur"),
    photo: typeof payload.picture === "string" ? payload.picture : null
  };
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}
async function issueLocalToken(userId, guest = false, expectedVersion = undefined) {
  const account = await pool.query("SELECT session_version FROM letchat_local_accounts WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>NOW())", [userId]);
  const version = account.rows[0]?.session_version;
  if (version === undefined || (expectedVersion !== undefined && version !== expectedVersion))
    throw Object.assign(new Error("La connexion a changé. Réessayez avec votre mot de passe actuel."), { status: 401, expose: true });
  // Sign the version actually checked, never a newer version after password verification.
  return new SignJWT({ guest, ver: version }).setProtectedHeader({ alg: "HS256" }).setSubject(userId)
    .setIssuer("letchat-local").setAudience("letchat").setIssuedAt()
    .setExpirationTime(guest ? "24h" : "30d").sign(localJwtSecret);
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
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
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

async function insertNotification(db, userId, type, title, body = "", actorId = null, referenceId = null) {
  const { rows } = await db.query(
    `WITH inserted AS (
       INSERT INTO letchat_notifications
       (user_id, type, title, body, actor_id, reference_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, type, title, body, actor_id, reference_id, read_at, created_at
     )
     SELECT n.*, COALESCE(p.display_name, '') AS actor_name, p.photo AS actor_photo
     FROM inserted n
     LEFT JOIN profiles p ON p.user_id = n.actor_id`,
    [userId, type, title, body, actorId, referenceId]
  );
  return rows[0];
}

function publishNotification(userId, notification) {
  io.to(`user:${userId}`).emit("notification", notification);
  const { title, body, type, actor_id: actorId } = notification;
  sendPushNotification(userId, { title, body, type, actorId }).catch(error =>
    console.error("Notification push :", error.message)
  );
}

async function createNotification(userId, type, title, body = "", actorId = null, referenceId = null) {
  const notification = await insertNotification(pool, userId, type, title, body, actorId, referenceId);
  publishNotification(userId, notification);
  return notification;
}

async function sendPushNotification(userId, payload) {
  if (!pushConfigured) return;
  const { rows } = await pool.query(
    `SELECT endpoint,p256dh,auth FROM letchat_push_subscriptions WHERE user_id=$1
     ORDER BY updated_at DESC LIMIT ${MAX_PUSH_SUBSCRIPTIONS}`,
    [userId]
  );
  await Promise.all(rows.map(async row => {
    try {
      await sendValidatedPush(webpush,
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        { ...payload, url: "/" }
      );
    } catch (error) {
      if (error.status === 400 || [404, 410].includes(error.statusCode)) {
        await pool.query("DELETE FROM letchat_push_subscriptions WHERE endpoint=$1 AND user_id=$2", [row.endpoint, userId]);
        return;
      }
      throw error;
    }
  }));
}

const RULES_VERSION = "2026-09-22-v1";
const actionBuckets = new Map();
const publicActionBuckets = new Map();

function rateLimitPublicAction(name, maximum, windowMs) {
  return (req, res, next) => {
    const address = String(req.ip || req.socket?.remoteAddress || "unknown");
    const key = `${name}:${address}`;
    const now = Date.now();
    const recent = (publicActionBuckets.get(key) || []).filter(time => now - time < windowMs);
    if (recent.length >= maximum) {
      const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      res.set("Retry-After", String(retrySeconds));
      return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${retrySeconds} secondes` });
    }
    recent.push(now);
    publicActionBuckets.set(key, recent);
    next();
  };
}

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

async function isRepeatedMessage({ userId, body, recipientId = null }, db = pool) {
  const normalized = normalizedMessageBody(body);
  if (normalized.length < 2) return false;
  const intervalSeconds = Math.ceil(MESSAGE_SPAM_WINDOW_MS / 1000);
  const query = recipientId
    ? await db.query(
        `SELECT body FROM letchat_private_messages
         WHERE sender_id=$1 AND recipient_id=$2
           AND created_at > NOW() - ($3 * INTERVAL '1 second')
           AND body IS NOT NULL AND body <> ''
         ORDER BY created_at DESC LIMIT 8`,
        [userId, recipientId, intervalSeconds]
      )
    : await db.query(
        `SELECT body FROM letchat_messages
         WHERE user_id=$1
           AND created_at > NOW() - ($2 * INTERVAL '1 second')
           AND body IS NOT NULL AND body <> ''
         ORDER BY created_at DESC LIMIT 8`,
        [userId, intervalSeconds]
      );
  return query.rows.filter(row => normalizedMessageBody(row.body) === normalized).length >= 2;
}

async function rejectSpamMessage(req, res, body, recipientId = null, db = pool) {
  const contentError = validateMessageContent(body);
  if (contentError) {
    res.status(400).json({ error: contentError });
    return true;
  }
  if (await isRepeatedMessage({ userId: req.user.id, body, recipientId }, db)) {
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
    contactEmail: String(process.env.CONTACT_EMAIL || "letchat@letchat.fr").trim(),
    advertisingEnabled: process.env.ADSENSE_ENABLED !== "false",
    advertisingPages: ["/decouvrir.html"],
    premiumConfigured: Boolean(stripe && process.env.STRIPE_PRICE_ID),
    premiumPlusConfigured: Boolean(stripe && process.env.STRIPE_PRICE_PLUS_ID),
    pushConfigured,
    vapidPublicKey: pushConfigured ? vapidPublicKey : ""
  });
});

installRecoveryRoutes({ app, pool, io, auth, rateLimitPublicAction, rateLimitAction });
const premiumBenefits = await installPremiumBenefits({ app, pool, auth, requireAdult, requireRules, rateLimitAction, hasPremiumAccess,
  onlineIds: () => [...new Set([...online.values()].filter(e => !premiumBenefits.isDiscreet(e.user.id)).map(e => e.user.id))], changed: refreshPremiumIdentity });
const social = await installSocial({ app, pool, io, auth, requireAdult, requireRules, rateLimitAction, hasPremiumAccess, roomCatalog, socketSessionValid });
const surprise = installSurprise({ io, pool, socketSessionValid, rulesVersion: RULES_VERSION });

app.post("/api/auth/register", rateLimitPublicAction("register", 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username), key = username.toLocaleLowerCase("fr");
    const password = String(req.body?.password || ""), age = Number(req.body?.age);
    const gender = ["female", "male", "neutral"].includes(req.body?.gender) ? req.body.gender : "neutral";
    const city = String(req.body?.city || "").trim().slice(0, 100);
    if (username.length < 3) return res.status(400).json({ error: "Le pseudonyme doit contenir au moins 3 caractères" });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères" });
    if (!Number.isInteger(age) || age < 18 || age > 120) return res.status(400).json({ error: "Letchat est réservé aux personnes majeures" });
    if (city.length < 2) return res.status(400).json({ error: "Ville incorrecte" });
    const userId = `local:${randomUUID()}`, salt = randomBytes(16).toString("hex"), recoveryCode = newRecoveryCode();
    const digest = await passwordDigest(password, salt);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO letchat_local_accounts(user_id,username,username_key,password_hash,password_salt,gender,city,recovery_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [userId,username,key,digest,salt,gender,city,recoveryHash(recoveryCode)]);
      await client.query(`INSERT INTO profiles(user_id,email,display_name,region,department,city,gender) VALUES($1,'',$2,'','',$3,$4)`, [userId,username,city,gender]);
      await client.query(`INSERT INTO letchat_age_consents(user_id,over_18) VALUES($1,TRUE) ON CONFLICT(user_id) DO UPDATE SET over_18=TRUE,accepted_at=NOW()`, [userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); if (error.code === "23505") return res.status(409).json({ error: "Ce pseudonyme est déjà utilisé" }); throw error; }
    finally { client.release(); }
    res.status(201).json({ recoveryCode, token: await issueLocalToken(userId), user: { id:userId, name:username, loginUsername:username, guest:false } });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", rateLimitPublicAction("login", 12, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const key = normalizeUsername(req.body?.username).toLocaleLowerCase("fr"), password = String(req.body?.password || "");
    if (password.length > 200) return res.status(401).json({ error: "Pseudonyme ou mot de passe incorrect" });
    const { rows } = await pool.query(`SELECT a.user_id,a.username,a.password_hash,a.password_salt,a.session_version,COALESCE(p.display_name,a.username) AS display_name,p.photo FROM letchat_local_accounts a LEFT JOIN profiles p ON p.user_id=a.user_id WHERE a.username_key=$1 AND a.is_guest=FALSE`, [key]);
    const row = rows[0];
    if (!row?.password_hash || !row.password_salt) return res.status(401).json({ error: "Pseudonyme ou mot de passe incorrect" });
    if (!await matchesPassword(password, row)) return res.status(401).json({ error: "Pseudonyme ou mot de passe incorrect" });
    res.json({ token: await issueLocalToken(row.user_id, false, row.session_version), user: { id:row.user_id, name:row.display_name, loginUsername:row.username, photo:row.photo, guest:false } });
  } catch (error) { next(error); }
});

app.post("/api/auth/guest", rateLimitPublicAction("guest", 15, 60 * 60 * 1000), async (req, res, next) => {
  try {
    let username = normalizeUsername(req.body?.username), age = Number(req.body?.age);
    const gender = ["female", "male", "neutral"].includes(req.body?.gender) ? req.body.gender : "neutral";
    const city = String(req.body?.city || "").trim().slice(0,100);
    if (username.length < 3 || !Number.isInteger(age) || age < 18 || age > 120 || city.length < 2) return res.status(400).json({ error: "Pseudonyme, âge ou ville incorrect" });
    let key = username.toLocaleLowerCase("fr");
    if ((await pool.query("SELECT 1 FROM letchat_local_accounts WHERE username_key=$1",[key])).rowCount) { const suffix = String(Math.floor(1000 + Math.random()*9000)); username = `${username.slice(0,35)}-${suffix}`; key = username.toLocaleLowerCase("fr"); }
    const userId = `guest:${randomUUID()}`, expiresAt = new Date(Date.now()+24*60*60*1000);
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query(`INSERT INTO letchat_local_accounts(user_id,username,username_key,is_guest,gender,city,expires_at) VALUES($1,$2,$3,TRUE,$4,$5,$6)`,[userId,username,key,gender,city,expiresAt]); await client.query(`INSERT INTO profiles(user_id,email,display_name,region,department,city,gender) VALUES($1,'',$2,'','',$3,$4)`,[userId,username,city,gender]); await client.query(`INSERT INTO letchat_age_consents(user_id,over_18) VALUES($1,TRUE)`,[userId]); await client.query("COMMIT"); }
    catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
    res.status(201).json({ token:await issueLocalToken(userId,true), user:{id:userId,name:username,guest:true}, expiresAt });
  } catch(error){next(error);}
});

app.get("/api/auth/me", auth, (req,res) => res.json({ user:{ id:req.user.id,name:req.user.name,loginUsername:req.user.local && !req.user.guest ? req.user.loginUsername : null,photo:req.user.photo,guest:Boolean(req.user.guest) } }));

app.get("/api/subscription", auth, requireAdult, async (req, res, next) => {
  try {
    const sessionId = String(req.query.session_id || "");
    if (sessionId) {
      if (!stripe || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId))
        return res.status(400).json({ error: "Session de paiement incorrecte" });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.client_reference_id !== req.user.id)
        return res.status(403).json({ error: "Ce paiement ne correspond pas à votre compte" });
      if (session.status === "complete" && session.payment_status !== "unpaid" && session.subscription) {
        await saveStripeSubscription(await stripe.subscriptions.retrieve(String(session.subscription)), req.user.id, true);
      }
    }
    const { rows } = await pool.query(
      "SELECT status,current_period_end,stripe_customer_id,stripe_subscription_id,plan FROM letchat_subscriptions WHERE user_id=$1",
      [req.user.id]
    );
    let row = rows[0];
    if (stripe && row?.stripe_subscription_id && row.status !== "canceled") {
      try {
        const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        if (String(subscription.customer) === row.stripe_customer_id) {
          await saveStripeSubscription(subscription, req.user.id);
          row = (await pool.query(
            "SELECT status,current_period_end,stripe_customer_id,stripe_subscription_id,plan FROM letchat_subscriptions WHERE user_id=$1",
            [req.user.id]
          )).rows[0];
        }
      } catch (error) { console.error("Actualisation abonnement :", error.message); }
    }
    const premium = Boolean(row && ["active", "trialing"].includes(row.status) &&
      (!row.current_period_end || new Date(row.current_period_end).getTime() > Date.now()));
    res.json({ premium, plan: row?.plan || null, status: row?.status || "free",
      currentPeriodEnd: row?.current_period_end || null, canManage: Boolean(row?.stripe_customer_id && row?.stripe_subscription_id) });
  } catch (error) { next(error); }
});

app.get("/api/premium/plans", async (_req, res, next) => {
  try {
    const plans = await Promise.all(Object.entries(premiumPrices).map(async ([id, priceId]) => {
      if (!stripe || !priceId) return { id, label: premiumLabel[id], available: false };
      try {
        const price = await stripe.prices.retrieve(priceId);
        return { id, label: premiumLabel[id], available: Boolean(price.active && price.type === "recurring" && Number.isInteger(price.unit_amount)),
          amount: price.unit_amount, currency: price.currency,
          interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count };
      } catch (error) {
        console.error("Tarif Stripe :", id, error.message);
        return { id, label: premiumLabel[id], available: false };
      }
    }));
    res.json({ plans });
  } catch (error) { next(error); }
});

app.post("/api/stripe/checkout", auth, requireAdult, rateLimitAction("stripe-checkout", 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    if (req.user.guest) return res.status(403).json({ error: "Créez un compte permanent avant de vous abonner." });
    const plan = req.body?.plan;
    if (!Object.hasOwn(premiumPrices, plan)) return res.status(400).json({ error: "Formule inconnue" });
    if (!stripe || !premiumPrices[plan]) return res.status(503).json({ error: "Cette formule est temporairement indisponible" });
    const baseUrl = String(process.env.PUBLIC_BASE_URL || "https://www.letchat.fr").replace(/\/$/, "");
    res.json(await createCheckout({ pool, stripe, user: req.user, plan, priceId: premiumPrices[plan], baseUrl }));
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
      // Export only blocks created by this member; never reveal who blocked them.
      pool.query("SELECT blocker_id,blocked_id,created_at FROM letchat_blocks WHERE blocker_id=$1", [uid]),
      pool.query("SELECT id,type,title,body,actor_id,reference_id,read_at,created_at FROM letchat_notifications WHERE user_id=$1 ORDER BY created_at", [uid]),
      // Incoming reports and reporters' identities remain in the admin-only moderation view.
      pool.query("SELECT id,reporter_id,reported_id,reason,details,status,created_at FROM letchat_reports WHERE reporter_id=$1 ORDER BY created_at", [uid]),
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
      social: await social.exportData(uid),
      premiumPreferences: (await pool.query("SELECT accent,frame,badge,discreet FROM letchat_premium_preferences WHERE user_id=$1",[uid])).rows[0] || null,
      note: "Les fichiers image et vidéo binaires ne sont pas inclus dans cet export JSON. Leurs types sont indiqués."
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=letchat-donnees-${new Date().toISOString().slice(0,10)}.json`);
    res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/account", auth, requireAdult, rateLimitAction("delete-account", 2, 24 * 60 * 60 * 1000), async (req, res, next) => withBillingQueue(req.user.id, async () => {
  const client = await pool.connect();
  let billingLocked = false;
  try {
    if (req.body.confirmation !== "SUPPRIMER") {
      return res.status(400).json({ error: "Confirmation incorrecte" });
    }
    const uid = req.user.id;
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`letchat-checkout:${uid}`]);
    billingLocked = true;
    const pending = (await client.query("SELECT * FROM letchat_billing_accounts WHERE user_id=$1", [uid])).rows[0];
    if (pending?.checkout_key && !pending.checkout_session_id)
      return res.status(409).json({ error: "Un paiement doit être vérifié avant la suppression du compte. Contactez le support." });
    if (stripe && pending?.stripe_customer_id) {
      const subscriptions = await stripe.subscriptions.list({ customer: pending.stripe_customer_id, status: "all", limit: 100 });
      if (subscriptions.data.some(item => !["canceled", "incomplete_expired"].includes(item.status)))
        return res.status(409).json({ error: "Terminez votre abonnement avant de supprimer le compte." });
    }
    if (stripe && pending?.checkout_session_id) {
      const checkout = await stripe.checkout.sessions.retrieve(pending.checkout_session_id);
      if (checkout.status === "open") await stripe.checkout.sessions.expire(checkout.id);
      if (checkout.status === "complete" && !(await client.query("SELECT 1 FROM letchat_subscriptions WHERE user_id=$1 AND stripe_subscription_id=$2", [uid, checkout.subscription])).rowCount)
        return res.status(409).json({ error: "Votre paiement est en cours de confirmation. Réessayez plus tard." });
    }
    const billing = await client.query("SELECT status FROM letchat_subscriptions WHERE user_id=$1", [uid]);
    if (billing.rows[0] && ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(billing.rows[0].status)) {
      return res.status(409).json({ error: "Annulez d’abord votre abonnement Premium depuis le portail Stripe" });
    }
    const anonymousId = `compte-supprime-${createHash("sha256").update(uid).digest("hex").slice(0,24)}`;
    await client.query("BEGIN");
    // Same account-then-profile lock order as private-message sending and cleanup.
    await client.query("SELECT user_id FROM letchat_local_accounts WHERE user_id=$1 FOR UPDATE", [uid]);
    await client.query("SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE", [uid]);
    await client.query("DELETE FROM letchat_message_reactions WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_messages WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_private_messages WHERE sender_id=$1 OR recipient_id=$1", [uid]);
    await client.query("DELETE FROM letchat_conversation_preferences WHERE user_id=$1 OR other_id=$1", [uid]);
    await client.query("DELETE FROM letchat_friends WHERE requester_id=$1 OR addressee_id=$1", [uid]);
    await client.query("DELETE FROM letchat_blocks WHERE blocker_id=$1 OR blocked_id=$1", [uid]);
    await client.query("DELETE FROM letchat_notifications WHERE user_id=$1 OR actor_id=$1", [uid]);
    await client.query("DELETE FROM letchat_push_subscriptions WHERE user_id=$1", [uid]);
    await client.query("UPDATE letchat_reports SET reporter_id=$2 WHERE reporter_id=$1", [uid, anonymousId]);
    await client.query("UPDATE letchat_reports SET reported_id=$2 WHERE reported_id=$1", [uid, anonymousId]);
    await client.query("DELETE FROM letchat_suspensions WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_consents WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_age_consents WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_subscriptions WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM letchat_billing_accounts WHERE user_id=$1", [uid]);
    await client.query("INSERT INTO letchat_session_revocations(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET revoked_before=NOW()", [uid]);
    await client.query("DELETE FROM letchat_local_accounts WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM profiles WHERE user_id=$1", [uid]);
    await client.query("COMMIT");
    premiumBenefits.forget(uid);
    io.to(`user:${uid}`).emit("account-deleted");
    io.in(`user:${uid}`).disconnectSockets(true);
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    let discard = false;
    if (billingLocked) try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`letchat-checkout:${req.user.id}`]); } catch { discard = true; }
    client.release(discard);
  }
}));

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
      "SELECT display_name, photo, city, bio, gender, availability, last_seen, location_visible, private_message_policy, verified FROM profiles WHERE user_id = $1",
      [req.user.id]
    );
    res.json(rows[0] ? { ...rows[0], loginUsername: req.user.local && !req.user.guest ? req.user.loginUsername : null } : null);
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
    let photo = req.user.photo || "";
    if (photoData) {
      const [header, base64] = photoData.split(",");
      const result = await validateMedia(base64, header.slice(5).split(";")[0]);
      photo = `data:${result.mediaType};base64,${result.media.toString("base64")}`;
    }
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
       RETURNING display_name, photo, city, bio, gender, availability, last_seen, location_visible, private_message_policy, verified`,
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
    await surprise.refresh(req.user.id);
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/profile/:userId", auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, display_name, photo, bio, gender, availability, last_seen, verified,
              CASE WHEN location_visible THEN city ELSE '' END AS city
       FROM profiles WHERE user_id = $1`,
      [String(req.params.userId)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Profil introuvable" });
    res.json((await premiumBenefits.decorate(rows))[0]);
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
    calls.endBetween(req.user.id, blockedId);
    social.live.endBetween(req.user.id, blockedId);
    await surprise.endBetween(req.user.id, blockedId);
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

app.post("/api/push/subscribe", auth, rateLimitAction("push-subscribe", 60, 60 * 60 * 1000), async (req, res, next) => {
  let client;
  try {
    if (!pushConfigured) return res.status(503).json({ error: "Notifications mobiles non configurées" });
    const subscription = validatePushSubscription(req.body);
    client = await pool.connect();
    await client.query("BEGIN");
    // Lock the member row so concurrent subscriptions cannot exceed the cap.
    const profile = await client.query("SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE", [req.user.id]);
    if (!profile.rowCount) throw Object.assign(new Error("Profil introuvable"), { status: 404, expose: true });
    const count = await client.query(
      "SELECT COUNT(*)::int AS total FROM letchat_push_subscriptions WHERE user_id=$1 AND endpoint<>$2",
      [req.user.id, subscription.endpoint]
    );
    if (count.rows[0].total >= MAX_PUSH_SUBSCRIPTIONS)
      throw Object.assign(new Error("Vous avez déjà activé les notifications sur 10 appareils. Désactivez-les sur un ancien appareil avant d’en ajouter un."), { status: 409, expose: true });
    await client.query(
      `INSERT INTO letchat_push_subscriptions (endpoint,user_id,p256dh,auth,user_agent,updated_at)
       VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,
         p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,user_agent=EXCLUDED.user_agent,updated_at=NOW()`,
      [subscription.endpoint, req.user.id, subscription.keys.p256dh, subscription.keys.auth,
        String(req.headers["user-agent"] || "").slice(0, 500)]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

app.delete("/api/push/subscribe", auth, async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || "").trim().slice(0, 2000);
    if (endpoint) {
      await pool.query(
        "DELETE FROM letchat_push_subscriptions WHERE endpoint=$1 AND user_id=$2",
        [endpoint, req.user.id]
      );
    }
    res.json({ ok: true });
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
    res.json(await premiumBenefits.decorate(rows));
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
    const rawKind = req.body.messageKind;
    const messageKind = ["public", "private", "group"].includes(rawKind) ? rawKind : null;
    const messageId = /^[1-9]\d{0,17}$/.test(String(req.body.messageId || "")) ? String(req.body.messageId) : null;
    if ((rawKind && !messageKind) || Boolean(messageKind) !== Boolean(messageId))
      return res.status(400).json({ error: "Référence du message incorrecte" });
    let evidenceBody = "", contextLabel = "";
    const allowedReasons = new Set(["harassment", "spam", "inappropriate", "fake", "other"]);
    if (messageKind) {
      let evidence;
      if (messageKind === "public") {
        evidence = await pool.query(`SELECT user_id AS author_id,LEFT(COALESCE(NULLIF(body,''),'[Média]'),2000) AS body,room AS context
          FROM letchat_messages WHERE id=$1 AND expires_at>NOW()`, [messageId]);
        if (evidence.rows[0] && isPremiumRoom(evidence.rows[0].context) && !await hasPremiumAccess(req.user.id))
          return res.status(403).json({ error: "Ce message appartient à un salon Premium." });
      } else if (messageKind === "private") {
        evidence = await pool.query(`SELECT sender_id AS author_id,LEFT(COALESCE(NULLIF(body,''),'[Média]'),2000) AS body,'Conversation privée' AS context
          FROM letchat_private_messages WHERE id=$1 AND expires_at>NOW() AND (sender_id=$2 OR recipient_id=$2)`, [messageId, req.user.id]);
      } else {
        evidence = await pool.query(`SELECT m.sender_id AS author_id,LEFT(COALESCE(NULLIF(m.body,''),'[Média]'),2000) AS body,g.name AS context
          FROM letchat_group_messages m JOIN letchat_groups g ON g.id=m.group_id
          JOIN letchat_group_members gm ON gm.group_id=m.group_id AND gm.user_id=$2 AND gm.status='accepted'
          WHERE m.id=$1 AND m.expires_at>NOW() AND m.created_at>=gm.joined_at
          AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=m.sender_id) OR (b.blocked_id=$2 AND b.blocker_id=m.sender_id))`, [messageId,req.user.id]);
      }
      if (!evidence.rowCount) return res.status(404).json({ error: "Message à signaler introuvable" });
      reportedId = evidence.rows[0].author_id; evidenceBody = evidence.rows[0].body;
      contextLabel = evidence.rows[0].context;
    } else if (!(await pool.query("SELECT 1 FROM profiles WHERE user_id=$1", [reportedId])).rowCount) {
      return res.status(404).json({ error: "Membre introuvable" });
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
         AND (($3::bigint IS NULL AND message_id IS NULL) OR (message_id=$3 AND message_kind=$4))
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [req.user.id, reportedId, messageId, messageKind]
    );
    if (recent.rowCount) {
      return res.status(429).json({ error: "Vous avez déjà signalé cet utilisateur récemment" });
    }
    await pool.query(
      `INSERT INTO letchat_reports
         (reporter_id, reported_id, reason, details, message_kind, message_id, evidence_body, context_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.user.id, reportedId, reason, details, messageKind, messageId, evidenceBody, contextLabel]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/me", auth, (req, res) => {
  res.json({ admin: isAdminUser(req.user) });
});

const adminConsole = await installAdmin({ app, pool, io, auth, adminAuth, isAdminUser,
  rateLimitAction, roomCatalog, getOnline: () => online, emitPresence,
  insertNotification, publishNotification, social, pushConfigured,
  billingConfigured: Boolean(stripe && premiumPrices.premium) });

const allowedRooms = new Set(Object.keys(roomCatalog));
const getRoom = value => allowedRooms.has(String(value)) ? String(value) : "cafe";
const isPremiumRoom = room => roomCatalog[room]?.premium === true;
async function hasPremiumAccess(userId, db = pool) {
  const result = await db.query(
    `SELECT 1 FROM letchat_subscriptions
     WHERE user_id=$1 AND status IN ('active','trialing')
       AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1`,
    [userId]
  );
  return result.rowCount > 0;
}
async function moveExpiredPremiumSockets(userId) {
  if (await hasPremiumAccess(userId)) return;
  const movedRooms = new Set();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.user?.id !== userId || !isPremiumRoom(socket.room)) continue;
    const previousRoom = socket.room;
    calls.end(socket.id, "premium-expired");
    social.live.removeUser(userId, `room:${previousRoom}`);
    socket.leave(previousRoom);
    socket.room = "cafe";
    socket.join("cafe");
    online.set(socket.id, { user: socket.user, room: "cafe" });
    socket.emit("premium-room-revoked");
    movedRooms.add(previousRoom);
  }
  for (const room of movedRooms) emitPresence(room);
  if (movedRooms.size) emitPresence("cafe");
}

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

app.get("/api/turn-credentials", auth, requireAdult, async (_req, res, next) => {
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
    if (isPremiumRoom(room) && !await hasPremiumAccess(req.user.id))
      return res.status(403).json({ error: "Ce salon est réservé aux membres Premium." });
    const { rows } = await pool.query(`
      SELECT m.id, m.user_id, m.author, m.room, m.photo, m.body, m.media_type, m.pinned,
             m.created_at, m.expires_at, m.reply_to_id,
             parent.author AS reply_author, parent.user_id AS reply_user_id, parent.body AS reply_body,
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
      `SELECT m.media_data, m.media_type, m.room FROM letchat_messages m
       WHERE m.id = $1 AND m.expires_at > NOW()
         AND NOT EXISTS (
           SELECT 1 FROM letchat_blocks b
           WHERE b.blocker_id = $2 AND b.blocked_id = m.user_id
         )`,
      [req.params.id, req.user.id]
    );
    if (isPremiumRoom(rows[0]?.room) && !await hasPremiumAccess(req.user.id))
      return res.status(403).json({ error: "Ce salon est réservé aux membres Premium." });
    if (!rows[0]?.media_data) return res.sendStatus(404);
    serveMedia(res, rows[0].media_data, rows[0].media_type);
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
    if (isPremiumRoom(room) && !await hasPremiumAccess(req.user.id))
      return res.status(403).json({ error: "Ce salon est réservé aux membres Premium." });
    const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;
    const { media, mediaType } = await validateMedia(req.body.mediaBase64, req.body.mediaType);

    if (!body && !media) return res.status(400).json({ error: "Message vide" });
    if (body && await rejectSpamMessage(req, res, body)) return;
    let reply = null;
    if (replyToId) {
      const result = await pool.query(
        "SELECT id, user_id, author, body FROM letchat_messages WHERE id=$1 AND room=$2 AND expires_at > NOW()",
        [replyToId, room]
      );
      if (!result.rowCount) return res.status(400).json({ error: "Message cité introuvable" });
      reply = result.rows[0];
    }

    const query = await adminConsole.withRoomWrite(req.user, room, db => db.query(
      `INSERT INTO letchat_messages
       (user_id, author, room, photo, body, media_data, media_type, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, author, room, photo, body, media_type, pinned, created_at, expires_at, reply_to_id,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, req.user.name, room, req.user.photo, body, media, mediaType || null, reply?.id || null]
    ));
    const message = { ...query.rows[0], reply_author: reply?.author || null, reply_user_id: reply?.user_id || null, reply_body: reply?.body || null, reactions: {}, my_reactions: [] };
    if (isPremiumRoom(room)) {
      const occupants = new Set([...io.sockets.sockets.values()]
        .filter(socket => isPremiumRoom(socket.room)).map(socket => socket.user.id));
      for (const userId of occupants) await moveExpiredPremiumSockets(userId);
    }
    io.to(room).emit("message", message);
    if (isPremiumRoom(room)) {
      const { rows: members } = await pool.query(
        `SELECT user_id FROM letchat_subscriptions
         WHERE status IN ('active','trialing')
           AND (current_period_end IS NULL OR current_period_end > NOW())`
      );
      members.forEach(member => io.to(`user:${member.user_id}`).emit("room-activity", { room, userId: req.user.id, messageId: message.id }));
    } else {
      io.emit("room-activity", { room, userId: req.user.id, messageId: message.id });
    }
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
    res.json(await premiumBenefits.decorate(rows));
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
              m.reply_to_id, parent.sender_name AS reply_author, parent.sender_id AS reply_user_id, parent.body AS reply_body,
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
      `SELECT m.media_data, m.media_type, m.sender_id, m.recipient_id, m.view_once, m.opened_at
       FROM letchat_private_messages m
       WHERE m.id=$1 AND m.expires_at > NOW()
         AND (m.sender_id=$2 OR m.recipient_id=$2)
         AND NOT EXISTS (
           SELECT 1 FROM letchat_blocks b
           WHERE (b.blocker_id=m.sender_id AND b.blocked_id=m.recipient_id)
              OR (b.blocker_id=m.recipient_id AND b.blocked_id=m.sender_id)
         )
         AND m.created_at > COALESCE((
           SELECT cp.hidden_before FROM letchat_conversation_preferences cp
           WHERE cp.user_id=$2 AND cp.other_id=CASE
             WHEN m.sender_id=$2 THEN m.recipient_id ELSE m.sender_id END
         ), '-infinity'::timestamptz)
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
    serveMedia(res, media.media_data, media.media_type);
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
  let client, inTransaction = false;
  try {
    const recipientId = String(req.body.recipientId || "").slice(0, 200);
    const body = String(req.body.body || "").trim().slice(0, 4000);
    const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;
    const viewOnce = req.body.viewOnce === true;
    const { media, mediaType } = await validateMedia(req.body.mediaBase64, req.body.mediaType);
    if (!recipientId || recipientId === req.user.id) {
      return res.status(400).json({ error: "Destinataire incorrect" });
    }
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    // Lock accounts before profiles, as deletion and expired-guest cleanup do.
    // Sorted participants also avoid opposite-direction sends locking in reverse.
    const accounts = await client.query(
      `SELECT user_id, (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS expired
       FROM letchat_local_accounts WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR SHARE`,
      [[req.user.id, recipientId]]
    );
    const participants = await client.query(
      "SELECT user_id,private_message_policy FROM profiles WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR UPDATE",
      [[req.user.id, recipientId]]
    );
    if (!participants.rows.some(row => row.user_id === req.user.id))
      return res.status(401).json({ error: "Votre compte n’est plus disponible. Reconnectez-vous." });
    const recipientProfile = participants.rows.find(row => row.user_id === recipientId);
    if (!recipientProfile)
      return res.status(404).json({ error: "Ce compte n’existe plus ou n’est pas disponible. Votre message n’a pas été envoyé." });
    for (const id of [req.user.id, recipientId]) {
      const account = accounts.rows.find(row => row.user_id === id);
      if (account?.expired || (/^(?:local|guest):/.test(id) && !account))
        return res.status(id === req.user.id ? 401 : 410).json({
          error: id === req.user.id ? "Votre session a expiré. Reconnectez-vous." : "Ce compte a expiré ou n’est plus disponible. Votre message n’a pas été envoyé."
        });
    }
    const blocked = await client.query(
      `SELECT 1 FROM letchat_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
      [req.user.id, recipientId]
    );
    if (blocked.rowCount) return res.status(403).json({ error: "Message impossible : utilisateur bloqué" });
    const privateMessagePolicy = recipientProfile.private_message_policy;
    if (privateMessagePolicy === "nobody") {
      return res.status(403).json({ error: "Cet utilisateur n’accepte pas les messages privés" });
    }
    if (privateMessagePolicy === "friends") {
      const friendship = await client.query(
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
    if (body && await rejectSpamMessage(req, res, body, recipientId, client)) return;
    if (viewOnce && (!media || !/^(image|video)\//.test(mediaType))) {
      return res.status(400).json({ error: "Le mode visible une fois est réservé aux photos et vidéos" });
    }
    let reply = null;
    if (replyToId) {
      const result = await client.query(
        `SELECT id, sender_id AS user_id, sender_name AS author, body FROM letchat_private_messages
         WHERE id=$1 AND expires_at > NOW()
           AND ((sender_id=$2 AND recipient_id=$3) OR (sender_id=$3 AND recipient_id=$2))`,
        [replyToId, req.user.id, recipientId]
      );
      if (!result.rowCount) return res.status(400).json({ error: "Message cité introuvable" });
      reply = result.rows[0];
    }
    const { rows } = await client.query(
      `INSERT INTO letchat_private_messages
       (sender_id,recipient_id,sender_name,sender_photo,body,media_data,media_type,reply_to_id,view_once)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
       WHERE NOT EXISTS (
         SELECT 1 FROM letchat_local_accounts WHERE user_id IN ($1,$2)
         AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()
       )
       RETURNING id, sender_id AS user_id, sender_name AS author,
                 sender_photo AS photo, body, media_type, created_at, expires_at, reply_to_id,
                 delivered_at, read_at, view_once, opened_at,
                 (media_data IS NOT NULL) AS has_media`,
      [req.user.id, recipientId, req.user.name, req.user.photo, body, media, mediaType || null, reply?.id || null, viewOnce]
    );
    if (!rows.length)
      return res.status(410).json({ error: "Un compte de cette conversation vient d’expirer. Votre message n’a pas été envoyé." });
    const message = { ...rows[0], private: true, recipient_id: recipientId, reply_author: reply?.author || null, reply_user_id: reply?.user_id || null, reply_body: reply?.body || null, reactions: {}, my_reactions: [] };
    await client.query(
      `INSERT INTO letchat_conversation_preferences (user_id,other_id,archived)
       VALUES ($1,$2,FALSE),($2,$1,FALSE)
       ON CONFLICT (user_id,other_id) DO UPDATE SET archived=FALSE, updated_at=NOW()`,
      [req.user.id, recipientId]
    );
    const recipientPreference = await client.query(
      "SELECT muted FROM letchat_conversation_preferences WHERE user_id=$1 AND other_id=$2",
      [recipientId, req.user.id]
    );
    let notification;
    if (!recipientPreference.rows[0]?.muted) {
      notification = await insertNotification(
        client, recipientId, "private_message", `Message de ${req.user.name}`,
        body ? body.slice(0, 160) : "Vous avez reçu un média.",
        req.user.id, String(message.id)
      );
    }
    await client.query("COMMIT");
    inTransaction = false;
    // No socket or push can announce a message whose transaction failed.
    if (notification) publishNotification(recipientId, notification);
    io.to(`user:${req.user.id}`).to(`user:${recipientId}`).emit("private-message", message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  } finally {
    let discard = false;
    if (inTransaction) await client.query("ROLLBACK").catch(() => { discard = true; });
    client?.release(discard);
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
    if (isPremiumRoom(result.rows[0]?.room) && !await hasPremiumAccess(userId)) return null;
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
  if (premiumBenefits.isDiscreet(userId))
    return { userId, online: false, availability: null, lastSeen: null, presence_hidden: true };
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
  if (premiumBenefits.isDiscreet(userId)) return { userId, online: false, availability: null, lastSeen: null, presence_hidden: true };
  return { userId, online: false, availability: rows[0]?.availability || "available", lastSeen: rows[0]?.last_seen || null };
}

async function emitPrivateStatus(userId) {
  io.to(`watch-status:${userId}`).emit("private-status", await getPrivateStatus(userId));
}

// Annuaire global réservé aux connexions Socket.IO authentifiées.
// Un membre reste présent tant qu’au moins un de ses onglets est connecté.
function onlineMemberDirectory(entries) {
  const members = new Map();
  for (const { user } of entries) {
    if (premiumBenefits.isDiscreet(user.id)) continue;
    const id = String(user.id);
    members.set(id, {
      id,
      name: user.name || "Membre",
      photo: user.photo || "",
      bio: user.profile?.bio || "",
      gender: ["female", "male"].includes(user.profile?.gender) ? user.profile.gender : "neutral",
      availability: user.profile?.availability || "available",
      verified: user.profile?.verified === true,
      city: user.profile?.location_visible === true ? user.profile.city || "" : "",
    });
  }
  return [...members.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}
let onlineDirectoryTimer;
function broadcastOnlineMembers() {
  clearTimeout(onlineDirectoryTimer);
  onlineDirectoryTimer = setTimeout(() => {
    io.emit("online-members", onlineMemberDirectory(online.values()));
  }, 80);
}

function emitPresence(room) {
  const people = [...online.entries()]
    .filter(([, entry]) => entry.room === room && !premiumBenefits.isDiscreet(entry.user.id))
    .map(([socketId, entry]) => ({
      id: entry.user.id,
      name: entry.user.name,
      photo: entry.user.photo,
      bio: entry.user.profile?.bio || "",
      gender: entry.user.profile?.gender || "neutral",
      availability: entry.user.profile?.availability || "available",
      verified: entry.user.profile?.verified === true,
      last_seen: entry.user.profile?.last_seen || null,
      socketId,
      location: entry.user.profile?.location_visible ? {
        city: entry.user.profile.city
      } : null
    }));
  io.to(room).emit("presence", people);
  broadcastOnlineMembers();
}

async function refreshPremiumIdentity(userId) {
  const info = (await premiumBenefits.info([userId])).get(userId), rooms = new Set();
  for (const socket of io.sockets.sockets.values()) if (socket.user?.id === userId) {
    socket.user.premiumInfo = info; rooms.add(socket.room);
    if (info?.discreet) {
      socket.to(socket.room).emit("typing", { userId, active: false });
      if (socket.privateTypingTarget) io.to(`user:${socket.privateTypingTarget}`).emit("private-typing", { userId, active: false });
      socket.privateTypingTarget = null;
    }
  }
  for (const room of rooms) emitPresence(room);
  await emitPrivateStatus(userId);
  io.emit("premium-appearance-updated", { id: userId, ...premiumBenefits.appearance(info), presence_hidden: premiumBenefits.isDiscreet(userId) });
  io.to(`user:${userId}`).emit("premium-benefits-updated");
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
      "SELECT display_name, photo, city, bio, gender, availability, last_seen, location_visible, verified FROM profiles WHERE user_id = $1",
      [socket.user.id]
    );
    socket.user.profile = rows[0] || null;
    socket.user.premiumInfo = (await premiumBenefits.info([socket.user.id])).get(socket.user.id);
    if (rows[0]?.display_name) socket.user.name = rows[0].display_name;
    if (rows[0]?.photo) socket.user.photo = rows[0].photo;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

const calls = new CallRegistry({ sockets: io.sockets.sockets, permitted: async (a, b) => {
  if (!await socketSessionValid(a) || !await socketSessionValid(b)) return false;
  if (isPremiumRoom(a.room) && (!await hasPremiumAccess(a.user.id) || !await hasPremiumAccess(b.user.id))) return false;
  const blocked = await pool.query(`SELECT 1 FROM letchat_blocks
    WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`, [a.user.id, b.user.id]);
  return !blocked.rowCount;
} });
async function socketSessionValid(socket) {
  try {
    if (Date.now() >= socket.user.expiresAt) return false;
    await verify(socket.handshake.auth?.token);
    if (isAdminUser(socket.user)) return true;
    return !(await pool.query(`SELECT 1 FROM letchat_suspensions WHERE user_id=$1
      AND (suspended_until IS NULL OR suspended_until > NOW())`, [socket.user.id])).rowCount;
  } catch { return false; }
}
io.on("connection", socket => {
  const expire = () => { socket.emit("session-expired"); socket.disconnect(true); };
  const expiryTimer = setTimeout(expire, Math.max(1, Math.min(2147483647, socket.user.expiresAt - Date.now())));
  expiryTimer.unref?.();
  const events = new Map();
  socket.use(async ([event], next) => {
    const now = Date.now(), limit = ["webrtc", "live-signal"].includes(event) ? 180 : 20;
    const recent = (events.get(event) || []).filter(t => now - t < 10000);
    if (recent.length >= limit) return next(new Error("rate-limited"));
    recent.push(now); events.set(event, recent);
    if (!await socketSessionValid(socket)) { expire(); return; }
    next();
  });
  surprise.attach(socket);
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

  socket.on("join-room", async value => {
    const nextRoom = getRoom(value);
    if (isPremiumRoom(nextRoom)) {
      try {
        if (!await hasPremiumAccess(socket.user.id)) {
          await moveExpiredPremiumSockets(socket.user.id);
          socket.emit("premium-room-denied");
          return;
        }
      } catch {
        socket.emit("premium-room-denied");
        return;
      }
    }
    const previousRoom = socket.room;
    if (previousRoom !== nextRoom) social.live.removeUser(socket.user.id, `room:${previousRoom}`);
    if (nextRoom === previousRoom) return emitPresence(nextRoom);
    calls.end(socket.id, "room-changed");
    socket.leave(previousRoom);
    socket.room = nextRoom;
    socket.join(nextRoom);
    online.set(socket.id, { user: socket.user, room: nextRoom });
    emitPresence(previousRoom);
    emitPresence(nextRoom);
  });

  socket.on("typing", async value => {
    if (premiumBenefits.isDiscreet(socket.user.id)) return;
    if (isPremiumRoom(socket.room) && !await hasPremiumAccess(socket.user.id).catch(() => false)) return;
    socket.to(socket.room).emit("typing", { userId: socket.user.id, name: socket.user.name, active: Boolean(value) });
  });

  socket.on("private-typing", async payload => {
    if (premiumBenefits.isDiscreet(socket.user.id)) return;
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

  socket.on("webrtc", payload => {
    calls.handle(socket, payload).catch(() => socket.emit("webrtc-error", { error: "Appel temporairement indisponible" }));
  });

  socket.on("disconnect", async () => {
    clearTimeout(expiryTimer);
    calls.end(socket.id, "disconnected");
    const room = socket.room;
    if (socket.privateTypingTarget) {
      io.to(`user:${socket.privateTypingTarget}`).emit("private-typing", {
        userId: socket.user.id,
        name: socket.user.name,
        active: false
      });
    }
    online.delete(socket.id);
    broadcastOnlineMembers();
    if (!userIsOnline(socket.user.id)) {
      await pool.query("UPDATE profiles SET last_seen=NOW() WHERE user_id=$1", [socket.user.id]).catch(() => {});
      await emitPrivateStatus(socket.user.id).catch(() => {});
    }
    emitPresence(room);
  });
});

async function deleteExpiredMessages() {
  try {
    const premiumOccupants = new Set([...io.sockets.sockets.values()]
      .filter(socket => isPremiumRoom(socket.room)).map(socket => socket.user.id));
    for (const userId of premiumOccupants) await moveExpiredPremiumSockets(userId);
    calls.prune();
    await social.prune();
    await purgeExpiredGuests(pool, io);
    const bucketCutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, times] of actionBuckets) {
      const active = times.filter(time => time > bucketCutoff);
      if (active.length) actionBuckets.set(key, active);
      else actionBuckets.delete(key);
    }
    for (const [key, times] of publicActionBuckets) {
      const active = times.filter(time => time > bucketCutoff);
      if (active.length) publicActionBuckets.set(key, active); else publicActionBuckets.delete(key);
    }
    for (const [key, times] of ipBuckets) {
      const active = times.filter(time => time > bucketCutoff);
      if (active.length) ipBuckets.set(key, active);
      else ipBuckets.delete(key);
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
  console.error(error.expose ? error.message : "Erreur serveur", error.code || error.name);
  const status = error.expose && Number.isInteger(error.status) ? error.status : error.type === "entity.too.large" ? 413 : 500;
  if (status === 503 && error.code === "AUTH_BUSY") res.set("Retry-After", "2");
  res.status(status).json({ error: error.expose ? error.message : status === 413 ? "Fichier trop volumineux" : "Erreur interne du serveur" });
});

app.use((_req, res) => {
  res.status(404).type("html").send('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Page introuvable — Letchat</title><h1>Page introuvable</h1><p><a href="/">Revenir à Letchat</a></p></html>');
});

server.listen(port, () => console.log(`Letchat prêt sur le port ${port}`));
