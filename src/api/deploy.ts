// =============================================================================
// Deploy API — bot deployment endpoints
// POST   /api/deploy/:workspaceId          → deploy bot
// POST   /api/deploy/:workspaceId/stop     → stop bot
// POST   /api/deploy/:workspaceId/restart  → restart bot
// GET    /api/deploy/:workspaceId/status   → deployment status
// GET    /api/deploy/:workspaceId/logs     → last N log lines
// =============================================================================

import { Hono } from 'hono';
import { deployBot, stopBot, restartBot, getBotStatus, getBotLogs } from '../services/bot/deployer';
import { logger } from '../utils/logger';
import * as db from '../db/queries';

const app = new Hono();

// ─── Ownership guard ─────────────────────────────────────────────────────────
// Every deploy endpoint must verify the requesting user owns the workspace.

async function assertOwnership(workspaceId: string, userId: string) {
  const workspace = await db.getWorkspace(workspaceId, userId);
  if (!workspace) throw new Error('NOT_FOUND');
  return workspace;
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

app.post('/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId      = c.get('userId') as string;

  try {
    await assertOwnership(workspaceId, userId);
  } catch {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  logger.info({ workspaceId, userId }, 'Deploy request received');

  // Fire off deploy async — client polls /status
  deployBot(workspaceId).catch(err => {
    logger.error({ workspaceId, err: err.message }, 'Background deploy error');
  });

  return c.json({ success: true, message: 'Deployment started' });
});

// ─── Stop ────────────────────────────────────────────────────────────────────

app.post('/:workspaceId/stop', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId      = c.get('userId') as string;

  try {
    await assertOwnership(workspaceId, userId);
  } catch {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  try {
    await stopBot(workspaceId);
    return c.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stop failed';
    return c.json({ success: false, error: msg }, 500);
  }
});

// ─── Restart ─────────────────────────────────────────────────────────────────

app.post('/:workspaceId/restart', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId      = c.get('userId') as string;

  try {
    await assertOwnership(workspaceId, userId);
  } catch {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  // Fire async, client polls status
  restartBot(workspaceId).catch(err => {
    logger.error({ workspaceId, err: err.message }, 'Background restart error');
  });

  return c.json({ success: true, message: 'Restart initiated' });
});

// ─── Status ──────────────────────────────────────────────────────────────────

app.get('/:workspaceId/status', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId      = c.get('userId') as string;

  try {
    await assertOwnership(workspaceId, userId);
  } catch {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const status = await getBotStatus(workspaceId);
  return c.json(status);
});

// ─── Logs ────────────────────────────────────────────────────────────────────

app.get('/:workspaceId/logs', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId      = c.get('userId') as string;

  try {
    await assertOwnership(workspaceId, userId);
  } catch {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const lines = Number(c.req.query('lines') ?? 80);
  const logs  = await getBotLogs(workspaceId, lines);
  return c.json({ logs });
});

export { app as deployRoutes };
