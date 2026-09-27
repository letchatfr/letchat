const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, expose: true }); };
const accents = ["default", "coral", "blue", "purple", "green"];
const frames = ["none", "gold", "coral", "blue", "purple"];
export async function installPremiumBenefits({ app, pool, auth, requireAdult, requireRules, rateLimitAction, hasPremiumAccess, onlineIds, changed }) {
  await pool.query(`CREATE TABLE IF NOT EXISTS letchat_premium_preferences (
    user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
    accent TEXT NOT NULL DEFAULT 'default', frame TEXT NOT NULL DEFAULT 'none',
    badge BOOLEAN NOT NULL DEFAULT TRUE, discreet BOOLEAN NOT NULL DEFAULT FALSE
  );`);
  const hidden = new Set((await pool.query("SELECT user_id FROM letchat_premium_preferences WHERE discreet=TRUE")).rows.map(row=>row.user_id));
  const queues = new Map();
  async function serialized(id, fn) {
    const before = queues.get(id) || Promise.resolve();
    const current = before.catch(()=>{}).then(fn); queues.set(id,current);
    try { return await current; } finally { if (queues.get(id)===current) queues.delete(id); }
  }
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const base = [auth, requireAdult];
  const premium = async (req, res, next) => {
    try { if (!await hasPremiumAccess(req.user.id)) return res.status(403).json({ error: "Cet avantage est réservé aux membres Premium." }); next(); } catch (e) { next(e); }
  };
  async function info(ids) {
    if (!ids.length) return new Map();
    const rows = (await pool.query(`SELECT p.user_id,COALESCE(x.accent,'default') AS accent,COALESCE(x.frame,'none') AS frame,
      COALESCE(x.badge,TRUE) AS badge,COALESCE(x.discreet,FALSE) AS discreet,
      COALESCE(s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end>NOW()),FALSE) AS active,
      s.current_period_end FROM profiles p LEFT JOIN letchat_premium_preferences x ON x.user_id=p.user_id
      LEFT JOIN letchat_subscriptions s ON s.user_id=p.user_id WHERE p.user_id=ANY($1::text[])`, [ids])).rows;
    return new Map(rows.map(row => [row.user_id, row]));
  }
  function appearance(row) {
    const active = row?.active === true && (!row.current_period_end || new Date(row.current_period_end).getTime() > Date.now());
    return { premium_badge: active && row.badge !== false, premium_accent: active && accents.includes(row.accent) ? row.accent : "default",
      premium_frame: active && frames.includes(row.frame) ? row.frame : "none" };
  }
  async function decorate(rows) {
    const metadata = await info(rows.map(p => p.user_id));
    return rows.map(p => {
      const settings = metadata.get(p.user_id), discreet = hidden.has(p.user_id);
      return { ...p, ...appearance(settings), presence_hidden: discreet,
        ...(discreet ? { last_seen: null, availability: null, online: false } : {}) };
    });
  }
  async function own(id) {
    const row = (await info([id])).get(id), active = await hasPremiumAccess(id);
    return { premium: active, albumLimit: active ? 36 : 12, groupLimit: active ? 20 : 8,
      accent: row?.accent || "default", frame: row?.frame || "none", badge: row?.badge !== false, discreet: row?.discreet === true };
  }
  app.get("/api/premium/benefits", ...base, wrap(async (req, res) => res.set("Cache-Control", "private, no-store").json(await own(req.user.id))));
  app.patch("/api/premium/preferences", ...base, requireRules, rateLimitAction("premium-preferences", 30, 60000), wrap(async (req, res) => serialized(req.user.id, async () => {
    const body = req.body || {}, keys = Object.keys(body);
    if (!keys.length || keys.some(key => !["accent", "frame", "badge", "discreet"].includes(key))) fail("Réglage incorrect");
    if ((Object.hasOwn(body,"accent") && !accents.includes(body.accent)) || (Object.hasOwn(body,"frame") && !frames.includes(body.frame))
      || ["badge","discreet"].some(key => Object.hasOwn(body,key) && typeof body[key] !== "boolean")) fail("Réglage incorrect");
    // A member may always turn privacy off, but enabling it requires Premium.
    if (!await hasPremiumAccess(req.user.id) && !(keys.length === 1 && body.discreet === false)) fail("Cet avantage est réservé aux membres Premium.", 403);
    await pool.query(`INSERT INTO letchat_premium_preferences(user_id,accent,frame,badge,discreet)
      VALUES($1,COALESCE($2,'default'),COALESCE($3,'none'),COALESCE($4,TRUE),COALESCE($5,FALSE))
      ON CONFLICT(user_id) DO UPDATE SET accent=COALESCE($2,letchat_premium_preferences.accent),frame=COALESCE($3,letchat_premium_preferences.frame),
      badge=COALESCE($4,letchat_premium_preferences.badge),discreet=COALESCE($5,letchat_premium_preferences.discreet)`,
      [req.user.id,body.accent??null,body.frame??null,body.badge??null,body.discreet??null]);
    if (body.discreet === true) hidden.add(req.user.id);
    if (body.discreet === false) hidden.delete(req.user.id);
    await changed(req.user.id);
    res.json(await own(req.user.id));
  })));
  app.post("/api/premium/appearances", ...base, rateLimitAction("premium-appearance", 120, 60000), wrap(async (req,res) => {
    if (!Array.isArray(req.body?.ids) || req.body.ids.length > 60 || req.body.ids.some(id => typeof id !== "string" || id.length > 200)) fail("Liste incorrecte");
    const metadata = await info([...new Set(req.body.ids)]);
    res.set("Cache-Control","private, no-store").json([...metadata].map(([id,row]) => ({ id, ...appearance(row) })));
  }));
  app.get("/api/premium/members", ...base, premium, rateLimitAction("premium-search", 60, 60000), wrap(async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0,80), city = String(req.query.city || "").trim().slice(0,60);
    const gender = String(req.query.gender || ""), availability = String(req.query.availability || ""), offset = Number(req.query.offset || 0);
    if (!["","female","male","neutral"].includes(gender) || !["","available","busy","away"].includes(availability)
      || !Number.isInteger(offset) || offset < 0 || offset > 1000) fail("Filtres incorrects");
    const escapeLike = s => s.replace(/[\\%_]/g, c => `\\${c}`);
    const connected = onlineIds();
    const { rows } = await pool.query(`SELECT p.user_id,p.display_name,p.photo,p.bio,p.gender,p.availability,p.last_seen,p.verified,
      CASE WHEN p.location_visible THEN p.city ELSE '' END AS city,
      (p.user_id=ANY($9::text[]) AND NOT COALESCE(pref.discreet,FALSE)) AS online
      FROM profiles p LEFT JOIN letchat_premium_preferences pref ON pref.user_id=p.user_id
      LEFT JOIN letchat_profile_extras x ON x.user_id=p.user_id
      WHERE p.user_id<>$1
      AND NOT EXISTS(SELECT 1 FROM letchat_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=p.user_id) OR (b.blocked_id=$1 AND b.blocker_id=p.user_id))
      AND NOT EXISTS(SELECT 1 FROM letchat_suspensions s WHERE s.user_id=p.user_id AND (s.suspended_until IS NULL OR s.suspended_until>NOW()))
      AND NOT EXISTS(SELECT 1 FROM letchat_local_accounts a WHERE a.user_id=p.user_id AND a.expires_at IS NOT NULL AND a.expires_at<=NOW())
      AND EXISTS(SELECT 1 FROM letchat_age_consents ac WHERE ac.user_id=p.user_id AND ac.over_18=TRUE)
      AND ($2='' OR p.display_name ILIKE '%'||$2||'%' OR p.bio ILIKE '%'||$2||'%' OR (
        (x.visibility='public' OR EXISTS(SELECT 1 FROM letchat_friends f WHERE f.status='accepted'
          AND ((f.requester_id=$1 AND f.addressee_id=p.user_id) OR (f.addressee_id=$1 AND f.requester_id=p.user_id))))
        AND (x.likes ILIKE '%'||$2||'%' OR x.character ILIKE '%'||$2||'%' OR x.looking_for ILIKE '%'||$2||'%')))
      AND ($3='' OR (p.location_visible AND p.city ILIKE '%'||$3||'%'))
      AND ($4='' OR p.gender=$4)
      AND ($5='' OR (NOT COALESCE(pref.discreet,FALSE) AND p.availability=$5))
      AND (NOT $6 OR (p.user_id=ANY($9::text[]) AND NOT COALESCE(pref.discreet,FALSE)))
      AND (NOT $7 OR (p.photo IS NOT NULL AND p.photo<>'') OR EXISTS(SELECT 1 FROM letchat_album_photos ap WHERE ap.user_id=p.user_id))
      ORDER BY LOWER(p.display_name),p.user_id LIMIT 25 OFFSET $8`,
      [req.user.id,escapeLike(q),escapeLike(city),gender,availability,req.query.online==="true",req.query.photo==="true",offset,connected]);
    res.set("Cache-Control","private, no-store").json({ members: await decorate(rows.slice(0,24)), nextOffset: rows.length>24 && offset<1000 ? offset+24 : null });
  }));
  return { info, appearance, decorate, own, isDiscreet: id => hidden.has(id), forget: id => hidden.delete(id) };
}
