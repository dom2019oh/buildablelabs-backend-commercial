// =============================================================================
// Internal Log Routes — key-protected via x-log-key header
// =============================================================================

import { Hono } from 'hono';
import { db } from '../db/client';
import { writeDebugLog } from '../utils/debugLog';
import { env } from '../config/env';

const app = new Hono();

const authorized = (c: { req: { header: (name: string) => string | undefined } }) =>
  (c.req.header('x-log-key') ?? '') === env.DEBUG_SECRET;

// ── GET /logs?limit=50 ───────────────────────────────────────────────────────
app.get('/logs', async (c) => {
  if (!authorized(c)) return c.json({ error: 'Forbidden' }, 403);

  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);

  try {
    const snap = await db()
      .collection('_debugLogs')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return c.json({ logs, count: logs.length });
  } catch (err) {
    return c.json({ error: 'Failed to fetch logs', detail: String(err) }, 500);
  }
});

// ── POST /client-error ───────────────────────────────────────────────────────
app.post('/client-error', async (c) => {
  try {
    const body = await c.req.json();
    await writeDebugLog({
      type: 'frontend_error',
      timestamp: new Date().toISOString(),
      path: body.path ?? 'unknown',
      message: body.message ?? 'Unknown frontend error',
      userId: body.userId ?? null,
      details: {
        stack: body.stack,
        component: body.component,
        url: body.url,
      },
    });
  } catch {
    // Never throw from error reporting
  }
  return c.json({ ok: true });
});

// ── DELETE /logs ─────────────────────────────────────────────────────────────
app.delete('/logs', async (c) => {
  if (!authorized(c)) return c.json({ error: 'Forbidden' }, 403);

  try {
    const snap = await db().collection('_debugLogs').limit(500).get();
    const batch = db().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    return c.json({ deleted: snap.size });
  } catch (err) {
    return c.json({ error: 'Failed to clear logs', detail: String(err) }, 500);
  }
});

export { app as debugRoutes };
