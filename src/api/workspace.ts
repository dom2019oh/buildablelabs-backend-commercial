// =============================================================================
// Workspace API Routes
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import * as db from '../db/queries';
import { workspaceLogger as logger } from '../utils/logger';

const app = new Hono();

// =============================================================================
// SCHEMAS
// =============================================================================

const createWorkspaceSchema = z.object({
  projectId: z.string().min(1),
});

const getFileSchema = z.object({
  filePath: z.string().min(1),
});

// =============================================================================
// ROUTES
// =============================================================================

// Get or create workspace
app.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  
  const parsed = createWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  try {
    const workspace = await db.getOrCreateWorkspace(parsed.data.projectId, userId);
    logger.info({ workspaceId: workspace.id, projectId: parsed.data.projectId }, 'Workspace retrieved/created');
    return c.json({ workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to get/create workspace');
    return c.json({ error: 'Failed to get workspace' }, 500);
  }
});

// Get workspace details
app.get('/:id', async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.req.param('id');

  try {
    const workspace = await db.getWorkspace(workspaceId, userId);
    if (!workspace) {
      return c.json({ error: 'Workspace not found' }, 404);
    }
    return c.json({ workspace });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to get workspace');
    return c.json({ error: 'Failed to get workspace' }, 500);
  }
});

// List all files in workspace
app.get('/:id/files', async (c) => {
  const workspaceId = c.req.param('id');

  try {
    const files = await db.getWorkspaceFiles(workspaceId);
    return c.json({ files });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to get files');
    return c.json({ error: 'Failed to get files' }, 500);
  }
});

// Get single file
app.get('/:id/files/*', async (c) => {
  const workspaceId = c.req.param('id');
  const filePath = c.req.path.replace(`/api/workspace/${workspaceId}/files/`, '');

  try {
    const file = await db.getFile(workspaceId, filePath);
    if (!file) {
      return c.json({ error: 'File not found' }, 404);
    }
    return c.json({ file });
  } catch (error) {
    logger.error({ error, workspaceId, filePath }, 'Failed to get file');
    return c.json({ error: 'Failed to get file' }, 500);
  }
});

// List generation sessions
app.get('/:id/sessions', async (c) => {
  const workspaceId = c.req.param('id');

  try {
    const sessions = await db.getSessions(workspaceId);
    return c.json({ sessions });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to get sessions');
    return c.json({ error: 'Failed to get sessions' }, 500);
  }
});

// Get operation history
app.get('/:id/operations', async (c) => {
  const workspaceId = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '100');

  try {
    const operations = await db.getOperationHistory(workspaceId, limit);
    return c.json({ operations });
  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to get operations');
    return c.json({ error: 'Failed to get operations' }, 500);
  }
});

export { app as workspaceRoutes };
