import { randomInt, randomUUID } from "node:crypto";

// One opt-in per account, owned by the tab that started the search.
// All transitions are serialized so two joins cannot reserve the same person.
export function installSurprise({ io, pool, socketSessionValid, rulesVersion }) {
  const entries = new Map(), attempts = new Map();
  let pending = Promise.resolve(), revision = 0;
  const serial = fn => {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  };
  const alive = entry => Boolean(io.sockets.sockets.get(entry.socketId)?.connected);
  const state = entry => ({
    revision: entry.revision,
    status: entry.partner ? "matched" : "waiting",
    matchId: entry.matchId || null,
    partner: entry.partner || null,
    waitingCount: [...entries.values()].filter(e => !e.partner && alive(e)).length,
    skipped: Boolean(entry.avoid?.size),
  });
  function publish(entry) {
    entry.revision = ++revision;
    io.to(entry.socketId).emit("surprise-state", state(entry));
  }
  function idle(socketId, reason = "left") {
    const value = { revision: ++revision, status: "idle", reason };
    io.to(socketId).emit("surprise-state", value);
    return value;
  }
  function remove(id, reason = "left") {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    idle(entry.socketId, reason);
    if (entry.partner) {
      const other = entries.get(entry.partner.id);
      if (other?.matchId === entry.matchId) {
        entries.delete(other.id);
        idle(other.socketId, reason === "blocked" ? "blocked" : "peer-left");
      }
    }
  }
  async function eligible(entry) {
    const socket = io.sockets.sockets.get(entry.socketId);
    if (!socket?.connected || !await socketSessionValid(socket)) return false;
    const result = await pool.query(`SELECT 1 FROM profiles p
      WHERE p.user_id=$1 AND p.private_message_policy='everyone'
        AND EXISTS (SELECT 1 FROM letchat_age_consents WHERE user_id=$1 AND over_18=TRUE)
        AND EXISTS (SELECT 1 FROM letchat_consents WHERE user_id=$1 AND rules_version=$2)`, [entry.id, rulesVersion]);
    return result.rowCount > 0 && socket.connected;
  }
  async function match(entry) {
    if (entries.get(entry.id) !== entry || entry.partner) return;
    const candidates = [...entries.values()].filter(e => e.id !== entry.id && !e.partner);
    while (candidates.length && alive(entry)) {
      const [other] = candidates.splice(randomInt(candidates.length), 1);
      if (entry.avoid?.has(other.id) || other.avoid?.has(entry.id)) continue;
      if (!await eligible(other)) { remove(other.id, "unavailable"); continue; }
      const blocked = await pool.query(`SELECT 1 FROM letchat_blocks
        WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`, [entry.id, other.id]);
      if (blocked.rowCount || !alive(other) || !alive(entry)) continue;
      // Eligibility can change while the other participant is checked.
      if (!await eligible(entry)) { remove(entry.id, "unavailable"); return; }
      if (!alive(other) || !alive(entry)) continue;
      const matchId = randomUUID();
      entry.matchId = other.matchId = matchId;
      entry.partner = { id: other.id, name: io.sockets.sockets.get(other.socketId).user.name };
      other.partner = { id: entry.id, name: io.sockets.sockets.get(entry.socketId).user.name };
      publish(entry); publish(other);
      return;
    }
  }
  function rateLimit(id) {
    const now = Date.now(), times = (attempts.get(id) || []).filter(t => now - t < 60000);
    if (times.length >= 12) throw new Error("Vous allez trop vite. Réessayez dans une minute.");
    times.push(now); attempts.set(id, times);
  }
  async function action(socket, kind, payload = {}) {
    const id = socket.user.id, existing = entries.get(id);
    if (existing && existing.socketId !== socket.id) {
      throw new Error("Une Rencontre Surprise est déjà ouverte dans un autre onglet. Quittez-la dans cet onglet.");
    }
    if (kind === "status") return existing ? { ...state(existing), revision: ++revision } : { revision: ++revision, status: "idle" };
    if (kind === "leave") {
      remove(id);
      return { revision: ++revision, status: "idle", reason: "left" };
    }
    if (kind === "join" && existing) {
      await match(existing);
      return entries.has(id) ? state(existing) : { revision: ++revision, status: "idle", reason: "unavailable" };
    }
    if (kind === "next" && (!existing?.partner || existing.matchId !== payload?.matchId)) {
      return existing ? state(existing) : { revision: ++revision, status: "idle" };
    }
    rateLimit(id);
    // Passing excludes previous partners only for this search. A new explicit
    // search after leaving starts fresh, with no silent 15-minute lockout.
    const avoid = new Set(kind === "next" ? existing.avoid : []);
    if (kind === "next") avoid.add(existing.partner.id);
    const entry = { id, socketId: socket.id, joinedAt: Date.now(), revision: 0, avoid };
    if (!await eligible(entry)) throw new Error("Pour participer, acceptez les règles et autorisez les messages privés de tout le monde dans votre profil.");
    if (kind === "next") remove(id, "next");
    if (!socket.connected) return { revision: ++revision, status: "idle", reason: "disconnected" };
    entries.set(id, entry); publish(entry);
    await match(entry);
    return entries.has(id) ? state(entry) : { revision: ++revision, status: "idle", reason: "unavailable" };
  }
  function attach(socket) {
    for (const kind of ["join", "next", "leave", "status"]) {
      socket.on(`surprise-${kind}`, (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        serial(() => action(socket, kind, payload)).then(
          result => reply({ ok: true, state: result }),
          error => reply({ ok: false, error: error.message?.startsWith("Pour participer") || error.message?.startsWith("Une Rencontre") || error.message?.startsWith("Vous allez") ? error.message : "Rencontre Surprise est temporairement indisponible. Réessayez." })
        );
      });
    }
    socket.on("disconnect", () => serial(() => {
      if (entries.get(socket.user.id)?.socketId === socket.id) remove(socket.user.id, "disconnected");
    }));
  }
  const timer = setInterval(() => serial(async () => {
    const now = Date.now();
    for (const [id, times] of attempts) if (now - times.at(-1) > 60000) attempts.delete(id);
    for (const entry of [...entries.values()]) {
      if (!entries.has(entry.id)) continue;
      if (!alive(entry)) remove(entry.id, "disconnected");
      else if (!entry.partner && now - entry.joinedAt > 10 * 60 * 1000) remove(entry.id, "timeout");
      else if (!await eligible(entry)) remove(entry.id, "unavailable");
    }
    // Retry queued pairs after transient errors or a block/privacy change.
    for (const entry of [...entries.values()]) {
      if (entries.get(entry.id) !== entry || entry.partner) continue;
      await match(entry);
      if (entries.get(entry.id) === entry && !entry.partner) publish(entry);
    }
  }).catch(() => {}), 5000);
  timer.unref?.();
  return {
    attach,
    endBetween: (a, b) => serial(() => {
      if (entries.get(a)?.partner?.id === b) remove(a, "blocked");
    }),
    refresh: id => serial(async () => {
      const entry = entries.get(id);
      if (entry && !await eligible(entry)) remove(id, "unavailable");
    }),
  };
}
