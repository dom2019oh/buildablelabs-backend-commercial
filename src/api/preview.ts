// =============================================================================
// Preview Server API Routes
// =============================================================================

import { Hono } from 'hono';
import * as db from '../db/queries';
import { previewLogger as logger } from '../utils/logger';
import { PreviewManager } from '../services/preview/manager';

const app = new Hono();

// =============================================================================
// ROUTES
// =============================================================================

// Start preview server for workspace
app.post('/:workspaceId/start', async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.req.param('workspaceId');

  try {
    // Verify workspace ownership
    const workspace = await db.getWorkspace(workspaceId, userId);
    if (!workspace) {
      return c.json({ error: 'Workspace not found' }, 404);
    }

    // Start preview server
    const previewUrl = await PreviewManager.start(workspaceId);
    
    await db.updateWorkspace(workspaceId, { preview_url: previewUrl, preview_status: 'running' });

    logger.info({ workspaceId, previewUrl }, 'Preview started');
    return c.json({ success: true, previewUrl });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to start preview');
    return c.json({ error: 'Failed to start preview' }, 500);
  }
});

// Stop preview server
app.post('/:workspaceId/stop', async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.req.param('workspaceId');

  try {
    // Verify workspace ownership
    const workspace = await db.getWorkspace(workspaceId, userId);
    if (!workspace) {
      return c.json({ error: 'Workspace not found' }, 404);
    }

    // Stop preview server
    await PreviewManager.stop(workspaceId);
    
    await db.updateWorkspace(workspaceId, { preview_url: null, preview_status: 'stopped' });

    logger.info({ workspaceId }, 'Preview stopped');
    return c.json({ success: true });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to stop preview');
    return c.json({ error: 'Failed to stop preview' }, 500);
  }
});

// Restart preview server
app.post('/:workspaceId/restart', async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.req.param('workspaceId');

  try {
    // Verify workspace ownership
    const workspace = await db.getWorkspace(workspaceId, userId);
    if (!workspace) {
      return c.json({ error: 'Workspace not found' }, 404);
    }

    // Restart preview server
    const previewUrl = await PreviewManager.restart(workspaceId);
    
    await db.updateWorkspace(workspaceId, { preview_url: previewUrl, preview_status: 'running' });

    logger.info({ workspaceId, previewUrl }, 'Preview restarted');
    return c.json({ success: true, previewUrl });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to restart preview');
    return c.json({ error: 'Failed to restart preview' }, 500);
  }
});

// Get preview status
app.get('/:workspaceId/status', async (c) => {
  const workspaceId = c.req.param('workspaceId');

  try {
    const status = PreviewManager.getStatus(workspaceId);
    return c.json({ status });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to get preview status');
    return c.json({ error: 'Failed to get preview status' }, 500);
  }
});

export { app as previewRoutes };
