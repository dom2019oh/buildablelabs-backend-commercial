// =============================================================================
// Generation API Routes
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import * as db from '../db/queries';
import { aiLogger as logger } from '../utils/logger';
import { GenerationPipeline } from '../services/ai/pipeline';
import { checkAndDeductCredits } from '../services/credits';

const app = new Hono();

// =============================================================================
// SCHEMAS
// =============================================================================

const generateSchema = z.object({
  prompt: z.string().min(1).max(10000),
  options: z.object({
    template: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
});

// =============================================================================
// ROUTES
// =============================================================================

// Start generation
app.post('/:workspaceId', async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.req.param('workspaceId');
  const body = await c.req.json();

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { prompt, options } = parsed.data;

  try {
    // Verify workspace ownership
    const workspace = await db.getWorkspace(workspaceId, userId);
    if (!workspace) {
      return c.json({ error: 'Workspace not found' }, 404);
    }

    // Check if already generating
    if (workspace.status === 'generating') {
      return c.json({ error: 'Generation already in progress' }, 409);
    }

    // Check and deduct credits before starting
    const creditResult = await checkAndDeductCredits(userId);
    if (!creditResult.success) {
      return c.json({ error: creditResult.message, code: 'INSUFFICIENT_CREDITS' }, 402);
    }

    // Create session
    const session = await db.createSession(workspaceId, userId, prompt);
    logger.info({ sessionId: session.id, workspaceId, prompt: prompt.slice(0, 100) }, 'Generation started');

    // Update workspace status
    await db.updateWorkspaceStatus(workspaceId, 'generating');

    // Run generation pipeline (async - updates DB via Realtime)
    const pipeline = new GenerationPipeline({
      workspaceId,
      userId,
      sessionId: session.id,
      prompt,
      options,
    });

    // Start pipeline in background (don't await)
    pipeline.run().catch((error) => {
      logger.error({ error, sessionId: session.id }, 'Pipeline failed');
    });

    return c.json({
      success: true,
      sessionId: session.id,
      message: 'Generation started. Subscribe to Realtime for updates.',
    });

  } catch (error) {
    logger.error({ error, workspaceId }, 'Failed to start generation');
    return c.json({ error: 'Failed to start generation' }, 500);
  }
});

// Get session status
app.get('/session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  try {
    const session = await db.getSession(sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ session });
  } catch (error) {
    logger.error({ error, sessionId }, 'Failed to get session');
    return c.json({ error: 'Failed to get session' }, 500);
  }
});

// Cancel generation (if supported)
app.post('/session/:sessionId/cancel', async (c) => {
  const sessionId = c.req.param('sessionId');

  try {
    await db.updateSession(sessionId, {
      status: 'failed',
      error_message: 'Cancelled by user',
      completed_at: new Date().toISOString(),
    });

    return c.json({ success: true, message: 'Generation cancelled' });
  } catch (error) {
    logger.error({ error, sessionId }, 'Failed to cancel generation');
    return c.json({ error: 'Failed to cancel generation' }, 500);
  }
});

export { app as generateRoutes };
