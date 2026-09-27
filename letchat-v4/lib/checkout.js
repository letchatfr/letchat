import { createHash, randomUUID } from "node:crypto";
const blockedStatuses = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
function failure(message, status = 409) { return Object.assign(new Error(message), { status, expose: true }); }
const localQueues = new Map();
export async function withBillingQueue(userId, action) {
  const previous = localQueues.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  localQueues.set(userId, current);
  await previous;
  try { return await action(); }
  finally { release(); if (localQueues.get(userId) === current) localQueues.delete(userId); }
}

export async function createCheckout(options) {
  return withBillingQueue(options.user.id, () => lockedCheckout(options));
}
async function lockedCheckout({ pool, stripe, user, plan, priceId, baseUrl }) {
  if (user.guest) throw failure("Créez un compte permanent avant de vous abonner.", 403);
  const client = await pool.connect();
  const lock = `letchat-checkout:${user.id}`;
  let locked = false;
  try {
    // Session advisory lock serializes attempts across processes. Writes below are
    // committed independently so retry keys survive a Stripe timeout or crash.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]); locked = true;
    // Authentication happened before waiting for the lock. Deletion could have
    // completed meanwhile: never create billing for a removed account.
    if (!(await client.query("SELECT 1 FROM profiles WHERE user_id=$1", [user.id])).rowCount)
      throw failure("Compte indisponible. Reconnectez-vous avant de payer.", 401);
    await client.query("INSERT INTO letchat_billing_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING", [user.id]);
    let row = (await client.query("SELECT * FROM letchat_billing_accounts WHERE user_id=$1", [user.id])).rows[0];
    const existing = (await client.query("SELECT stripe_customer_id,stripe_subscription_id FROM letchat_subscriptions WHERE user_id=$1", [user.id])).rows[0];
    if (existing?.stripe_subscription_id) {
      const current = await stripe.subscriptions.retrieve(existing.stripe_subscription_id);
      if (blockedStatuses.has(current.status)) throw failure("Vous avez déjà un abonnement. Utilisez « Gérer mon abonnement ».");
    }
    if (!row.stripe_customer_id) {
      const customerId = existing?.stripe_customer_id || (await stripe.customers.create({
        metadata: { userId: user.id },
        ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email || "") ? { email: user.email } : {})
      }, { idempotencyKey: `letchat-customer-v1-${createHash("sha256").update(user.id).digest("hex")}` })).id;
      await client.query("UPDATE letchat_billing_accounts SET stripe_customer_id=$2 WHERE user_id=$1", [user.id, customerId]);
      row.stripe_customer_id = customerId;
    }
    const subscriptions = await stripe.subscriptions.list({ customer: row.stripe_customer_id, status: "all", limit: 100 });
    if (subscriptions.data.some(s => blockedStatuses.has(s.status)))
      throw failure("Un abonnement existe déjà ou son paiement est en cours de confirmation. Actualisez votre profil.");
    if (row.checkout_session_id) {
      const session = await stripe.checkout.sessions.retrieve(row.checkout_session_id);
      if (session.status === "complete" && session.subscription !== existing?.stripe_subscription_id)
        throw failure("Ce paiement est en cours de confirmation. Actualisez votre profil.");
      if (session.status === "open" && row.checkout_plan === plan) return { url: session.url };
      if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
      // Only an explicitly expired session allows a replacement checkout.
      await client.query("UPDATE letchat_billing_accounts SET checkout_session_id=NULL,checkout_key=NULL,checkout_params=NULL WHERE user_id=$1", [user.id]);
      row.checkout_key = null;
    }
    if (!row.checkout_key) {
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active || price.type !== "recurring") throw failure("Cette formule est temporairement indisponible", 503);
      row.checkout_key = randomUUID();
      row.checkout_params = {
        mode: "subscription", customer: row.stripe_customer_id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/?premium=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?premium=cancel`,
        client_reference_id: user.id, metadata: { userId: user.id, plan },
        subscription_data: { metadata: { userId: user.id, plan } },
        allow_promotion_codes: true, expires_at: Math.floor(Date.now() / 1000) + 3600
      };
      row.checkout_plan = plan;
      await client.query(`UPDATE letchat_billing_accounts SET checkout_key=$2,checkout_plan=$3,
        checkout_params=$4,checkout_started_at=NOW() WHERE user_id=$1`,
      [user.id, row.checkout_key, plan, JSON.stringify(row.checkout_params)]);
    }
    // After the idempotency retention window, don't risk creating a duplicate
    // whose earlier response was lost. Reconciliation needs the Stripe dashboard.
    if (row.checkout_started_at && Date.now() - new Date(row.checkout_started_at).getTime() > 23 * 3600000)
      throw failure("Un ancien paiement doit être vérifié. Contactez le support avant de réessayer.");
    const session = await stripe.checkout.sessions.create(row.checkout_params, { idempotencyKey: `letchat-checkout-${row.checkout_key}` });
    await client.query("UPDATE letchat_billing_accounts SET checkout_session_id=$2 WHERE user_id=$1", [user.id, session.id]);
    if (row.checkout_plan !== plan) throw failure("La tentative précédente a été retrouvée. Réessayez pour changer de formule.");
    return { url: session.url };
  } finally {
    let discard = false;
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]); }
      catch { discard = true; }
    }
    client.release(discard);
  }
}
