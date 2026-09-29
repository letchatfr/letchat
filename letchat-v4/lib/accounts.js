import { randomBytes, createHash } from "node:crypto";
import { passwordDigest, matchesPassword } from "./passwords.js";
export const newRecoveryCode = () => randomBytes(24).toString("hex").toUpperCase().match(/.{1,6}/g).join("-");
export const recoveryHash = code => createHash("sha256").update(String(code).replace(/[-\s]/g, "").toUpperCase()).digest("hex");
export function installRecoveryRoutes({ app, pool, io, auth, rateLimitPublicAction, rateLimitAction }) {
  app.post("/api/auth/recover", rateLimitPublicAction("recover", 8, 15 * 60000), async (req, res, next) => {
    try {
      const key = String(req.body?.username || "").trim().replace(/\s+/g, " ").slice(0, 40).toLocaleLowerCase("fr");
      const password = String(req.body?.password || "");
      const code = String(req.body?.recoveryCode || "").replace(/[-\s]/g, "");
      if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Choisissez un mot de passe de 8 à 200 caractères" });
      if (!/^[a-f0-9]{48}$/i.test(code)) return res.status(400).json({ error: "Pseudonyme ou code de récupération incorrect" });
      const salt = randomBytes(16).toString("hex"), recoveryCode = newRecoveryCode();
      const digest = await passwordDigest(password, salt);
      // Single atomic consume: concurrent resets cannot both use the same code.
      const result = await pool.query(`UPDATE letchat_local_accounts
        SET password_hash=$3,password_salt=$4,recovery_hash=$5,session_version=session_version+1
        WHERE username_key=$1 AND recovery_hash=$2 AND is_guest=FALSE RETURNING user_id,username`,
      [key, recoveryHash(code), digest, salt, recoveryHash(recoveryCode)]);
      if (!result.rowCount) return res.status(400).json({ error: "Pseudonyme ou code de récupération incorrect" });
      io.to(`user:${result.rows[0].user_id}`).emit("session-revoked");
      io.in(`user:${result.rows[0].user_id}`).disconnectSockets(true);
      res.json({ ok: true, recoveryCode, loginUsername: result.rows[0].username });
    } catch (error) { next(error); }
  });
  app.post("/api/account/recovery-code", auth, rateLimitAction("recovery-code", 5, 3600000), async (req, res, next) => {
    try {
      if (!req.user.local || req.user.guest) return res.status(400).json({ error: "Cette option est réservée aux comptes avec pseudonyme et mot de passe" });
      const row = (await pool.query("SELECT username,password_hash,password_salt,session_version FROM letchat_local_accounts WHERE user_id=$1 AND is_guest=FALSE", [req.user.id])).rows[0];
      if (!await matchesPassword(String(req.body?.password || ""), row)) return res.status(403).json({ error: "Mot de passe incorrect" });
      const recoveryCode = newRecoveryCode();
      const result = await pool.query("UPDATE letchat_local_accounts SET recovery_hash=$2 WHERE user_id=$1 AND session_version=$3", [req.user.id, recoveryHash(recoveryCode), row.session_version]);
      if (!result.rowCount) return res.status(409).json({ error: "La session a changé. Reconnectez-vous." });
      res.json({ recoveryCode, loginUsername: row.username });
    } catch (error) { next(error); }
  });
}

export async function purgeExpiredGuests(pool, io) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT a.user_id FROM letchat_local_accounts a
      WHERE a.is_guest=TRUE AND a.expires_at <= NOW()
      AND NOT EXISTS (SELECT 1 FROM letchat_subscriptions s WHERE s.user_id=a.user_id
        AND s.status NOT IN ('free','canceled','incomplete_expired'))
      LIMIT 100 FOR UPDATE OF a SKIP LOCKED`);
    const ids = rows.map(r => r.user_id);
    if (!ids.length) { await client.query("COMMIT"); return; }
    for (const [table, columns] of [
      ["letchat_messages", ["user_id"]], ["letchat_private_messages", ["sender_id", "recipient_id"]],
      ["letchat_message_reactions", ["user_id"]], ["letchat_conversation_preferences", ["user_id", "other_id"]],
      ["letchat_friends", ["requester_id", "addressee_id"]], ["letchat_blocks", ["blocker_id", "blocked_id"]],
      ["letchat_notifications", ["user_id", "actor_id"]], ["letchat_push_subscriptions", ["user_id"]],
      ["letchat_consents", ["user_id"]], ["letchat_age_consents", ["user_id"]], ["letchat_suspensions", ["user_id"]],
      ["letchat_subscriptions", ["user_id"]], ["letchat_billing_accounts", ["user_id"]],
      ["profiles", ["user_id"]], ["letchat_local_accounts", ["user_id"]]
    ]) await client.query(`DELETE FROM ${table} WHERE ${columns.map(c => `${c}=ANY($1::text[])`).join(" OR ")}`, [ids]);
    for (const id of ids) {
      const anonymous = `invite-expire-${createHash("sha256").update(id).digest("hex").slice(0,24)}`;
      await client.query("UPDATE letchat_reports SET reporter_id=$2 WHERE reporter_id=$1", [id, anonymous]);
      await client.query("UPDATE letchat_reports SET reported_id=$2 WHERE reported_id=$1", [id, anonymous]);
    }
    await client.query("COMMIT");
    for (const id of ids) { io.to(`user:${id}`).emit("session-expired"); io.in(`user:${id}`).disconnectSockets(true); }
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
