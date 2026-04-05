// =============================================================================
// Chat API — Buildable's conversational layer
// =============================================================================
// Handles all user messages before any code is generated.
// Returns a response + intent so the frontend knows whether to trigger the
// build pipeline or just display the message.

import { Hono } from 'hono';
import { Conversationalist } from '../services/ai/conversationalist';
import * as db from '../db/queries';
import { aiLogger as logger } from '../utils/logger';

const chat = new Hono();

// POST /api/chat
chat.post('/', async (c) => {
  const userId = c.get('userId') as string;

  let body: {
    workspaceId: string;
    message: string;
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { workspaceId, message, conversationHistory = [] } = body;

  if (!workspaceId || !message?.trim()) {
    return c.json({ error: 'workspaceId and message are required' }, 400);
  }

  try {
    // Get current project files for context
    const existingFiles = await db.getWorkspaceFiles(workspaceId);

    const conversationalist = new Conversationalist();
    const { response } = await conversationalist.respond(
      message.trim(),
      conversationHistory,
      existingFiles
    );

    return c.json({
      message: response.message,
      intent: response.intent,
      buildPrompt: response.buildPrompt ?? null,
    });

  } catch (error) {
    logger.error({ error, workspaceId, userId }, 'Chat endpoint error');
    return c.json({ error: 'Failed to generate response' }, 500);
  }
});

export { chat as chatRoutes };
