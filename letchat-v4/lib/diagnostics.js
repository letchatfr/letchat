import { performance } from 'node:perf_hooks';

// Operational aggregates only. Never keep URLs, messages, identifiers or stack traces.
export function createDiagnostics({ now = Date.now } = {}) {
  const buckets = new Map();
  const startedAt = now();
  const events = new Set(['client_error', 'socket_disconnected', 'call_connected', 'call_failed', 'turn_unavailable']);
  function bucket() {
    const key = Math.floor(now() / 600000);
    for (const old of buckets.keys()) if (old < key - 143) buckets.delete(old);
    if (!buckets.has(key)) buckets.set(key, { requests: 0, errors: 0, slow: 0, totalMs: 0, maxMs: 0, events: {} });
    return buckets.get(key);
  }
  return {
    middleware(req, res, next) {
      const start = performance.now();
      res.once('finish', () => {
        if (!req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/api/health') || req.originalUrl.startsWith('/api/ready')) return;
        const b = bucket(), ms = Math.round(performance.now() - start);
        b.requests++; b.totalMs += ms; b.maxMs = Math.max(b.maxMs, ms);
        if (res.statusCode >= 500) b.errors++;
        if (ms > 1000) b.slow++;
      });
      next();
    },
    record(event) {
      if (!events.has(event)) return false;
      const b = bucket(); b.events[event] = (b.events[event] || 0) + 1;
      return true;
    },
    snapshot() {
      bucket();
      const total = { requests: 0, errors: 0, slow: 0, totalMs: 0, maxMs: 0, events: {} };
      for (const b of buckets.values()) {
        for (const key of ['requests', 'errors', 'slow', 'totalMs']) total[key] += b[key];
        total.maxMs = Math.max(total.maxMs, b.maxMs);
        for (const [event, count] of Object.entries(b.events)) total.events[event] = (total.events[event] || 0) + count;
      }
      return { ...total, meanMs: total.requests ? Math.round(total.totalMs / total.requests) : 0,
        startedAt: new Date(startedAt).toISOString(), windowHours: 24, updatedAt: new Date(now()).toISOString() };
    }
  };
}

export function installDiagnostics({ app, pool, auth, adminAuth, requireAdult, rateLimitAction, diagnostics }) {
  app.get('/api/ready', async (_req, res) => {
    try { await pool.query({ text: 'SELECT 1', query_timeout: 2000 }); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.post('/api/diagnostics/events', auth, requireAdult, rateLimitAction('diagnostics', 20, 60000), (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !diagnostics.record(req.body.event))
      return res.status(400).json({ error: 'Événement incorrect' });
    res.status(204).end();
  });
  app.get('/api/admin/diagnostics', auth, adminAuth, async (_req, res, next) => {
    const start = performance.now();
    try {
      await pool.query({ text: 'SELECT 1', query_timeout: 2000 });
      res.json({ ...diagnostics.snapshot(), databaseMs: Math.round(performance.now() - start),
        version: '3.0.0', commit: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 12),
        turnConfigured: Boolean(process.env.METERED_DOMAIN && (process.env.METERED_TURN_API_KEY || process.env.METERED_SECRET_KEY || process.env.METERED_API_KEY)),
        memoryMiB: Math.round(process.memoryUsage().rss / 1048576), uptimeSeconds: Math.floor(process.uptime()) });
    } catch (error) { next(error); }
  });
}
