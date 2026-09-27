// Four participants, mesh WebRTC. Only members explicitly joining a scope can exchange signalling.
export function installLive({ io, pool, blocked, member, hasPremiumAccess, roomCatalog, socketSessionValid }) {
  const scopes = new Map();
  const locks = new Map();
  const reject = text => { throw new Error(text); };
  const identity = s => ({ socketId: s.id, userId: s.user.id, name: s.user.name, camera: Boolean(s.liveCamera), mic: Boolean(s.liveMic) });
  async function allowed(s, scope) {
    if (!await socketSessionValid(s)) return false;
    if (scope.startsWith("group:")) { try { await member(scope.slice(6), s.user.id); return true; } catch { return false; } }
    const room = scope.slice(5);
    return scope.startsWith("room:") && Object.hasOwn(roomCatalog, room) && room !== "messages" && s.room === room
      && (room !== "entraide" || await hasPremiumAccess(s.user.id));
  }
  const participants = scope => [...(scopes.get(scope) || [])].map(id => io.sockets.sockets.get(id)).filter(Boolean);
  function leave(s, reason = "left") {
    const scope = s.liveScope;
    if (!scope) return;
    s.liveScope = null; s.liveCamera = false; s.liveMic = false;
    scopes.get(scope)?.delete(s.id);
    if (!scopes.get(scope)?.size) scopes.delete(scope);
    for (const peer of participants(scope)) peer.emit("live-left", { socketId: s.id });
    s.emit("live-ended", { reason });
  }
  async function serialized(key, fn) {
    const prior = locks.get(key) || Promise.resolve();
    const current = prior.catch(() => {}).then(fn); locks.set(key, current);
    try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  }
  io.on("connection", s => {
    s.on("live-join", (value, ack) => {
      const scope = typeof value?.scope === "string" ? value.scope.slice(0, 100) : "";
      serialized(`socket:${s.id}`, () => serialized(scope, async () => {
        if (!s.connected || !await allowed(s, scope)) reject("Accès à cette visio refusé");
        const rules = await pool.query("SELECT 1 FROM letchat_consents WHERE user_id=$1 AND rules_version='2026-09-22-v1'", [s.user.id]);
        if (!rules.rowCount) reject("Acceptez d’abord les règles du site");
        if (s.liveScope === scope) return { peers: participants(scope).filter(p => p.id !== s.id).map(identity), scope };
        const existing = participants(scope);
        if (existing.length >= 4) reject("Les quatre places sont occupées. Réessayez plus tard.");
        if (existing.some(p => p.user.id === s.user.id)) reject("Vous participez déjà depuis un autre onglet");
        for (const peer of existing) if (await blocked(s.user.id, peer.user.id)) reject("Un blocage empêche de rejoindre cette visio");
        if (!s.connected) reject("Connexion interrompue");
        leave(s);
        s.liveScope = scope;
        if (!scopes.has(scope)) scopes.set(scope, new Set());
        scopes.get(scope).add(s.id);
        for (const peer of existing) peer.emit("live-peer", identity(s));
        return { peers: existing.map(identity), scope };
      })).then(data => { if (typeof ack === "function") ack({ ok: true, ...data }); })
        .catch(e => { if (typeof ack === "function") ack({ ok: false, error: e.message }); });
    });
    s.on("live-leave", () => leave(s));
    s.on("live-state", value => {
      if (!s.liveScope) return;
      s.liveCamera = value?.camera === true; s.liveMic = value?.mic === true;
      for (const peer of participants(s.liveScope)) peer.emit("live-state", identity(s));
    });
    s.on("live-signal", (payload, ack) => {
      (async () => {
        const target = io.sockets.sockets.get(String(payload?.target || ""));
        if (!s.liveScope || !target || target.liveScope !== s.liveScope) reject("Signal refusé");
        const scope = s.liveScope;
        if (!await allowed(s, scope) || !await allowed(target, scope) || await blocked(s.user.id, target.user.id)) { leave(s, "access"); reject("Accès retiré"); }
        const data = payload.data;
        if (!data || JSON.stringify(data).length > 50000 || !["offer", "answer", "candidate"].includes(data.type)) reject("Signal incorrect");
        if (["offer", "answer"].includes(data.type) && typeof data.sdp !== "string") reject("Signal incorrect");
        if (!s.connected || !target.connected || s.liveScope !== scope || target.liveScope !== scope) reject("Visio terminée");
        target.emit("live-signal", { from: s.id, data });
      })().then(() => { if (typeof ack === "function") ack({ ok: true }); }).catch(e => { if (typeof ack === "function") ack({ ok: false, error: e.message }); });
    });
    s.on("disconnect", () => leave(s, "disconnected"));
  });
  return {
    removeUser(uid, scope) { for (const s of io.sockets.sockets.values()) if (s.user?.id === uid && (!scope || s.liveScope === scope)) leave(s, "access"); },
    closeScope(scope) { for (const s of participants(scope)) leave(s, "closed"); },
    endBetween(a, b) { for (const scope of scopes.keys()) { const list = participants(scope); if (list.some(s => s.user.id === a) && list.some(s => s.user.id === b)) for (const s of list) if ([a, b].includes(s.user.id)) leave(s, "blocked"); } },
    async prune() { for (const s of io.sockets.sockets.values()) if (s.liveScope && !await allowed(s, s.liveScope)) leave(s, "access"); }
  };
}
