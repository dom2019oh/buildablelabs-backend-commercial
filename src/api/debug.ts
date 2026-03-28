// =============================================================================
// Debug Routes — read logs + receive frontend errors
// All unauthenticated but key-protected (DEBUG_SECRET env var)
// =============================================================================

import { Hono } from 'hono';
import { db } from '../db/client';
import { writeDebugLog } from '../utils/debugLog';
import { env } from '../config/env';

const app = new Hono();

// ── Key guard ────────────────────────────────────────────────────────────────
const checkKey = (key: string | null) => key === env.DEBUG_SECRET;

// ── GET /api/debug/logs?key=SECRET&limit=50 ──────────────────────────────────
app.get('/logs', async (c) => {
  if (!checkKey(c.req.query('key') ?? null)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);

  const snap = await db()
    .collection('_debugLogs')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return c.json({ logs, count: logs.length });
});

// ── POST /api/debug/client-error ─────────────────────────────────────────────
// Frontend posts unhandled errors here (no auth required — errors happen before auth)
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
    // Swallow — don't let error reporting cause more errors
  }
  return c.json({ ok: true });
});

// ── DELETE /api/debug/logs?key=SECRET ────────────────────────────────────────
app.delete('/logs', async (c) => {
  if (!checkKey(c.req.query('key') ?? null)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const snap = await db().collection('_debugLogs').limit(500).get();
  const batch = db().batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();

  return c.json({ deleted: snap.size });
});

export { app as debugRoutes };
