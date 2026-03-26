// =============================================================================
// BUILDABLE BACKEND - Entry Point
// =============================================================================
// The AI Brain and Filesystem Authority for Buildable.
// This server handles all AI orchestration, file management, and preview control.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { env } from './config/env';
import { logger } from './utils/logger';
import admin from 'firebase-admin';

// Initialise Firebase Admin once
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// Routes
import { workspaceRoutes } from './api/workspace';
import { generateRoutes } from './api/generate';
import { previewRoutes } from './api/preview';
import { creditRoutes } from './api/credits';
import { billingRoutes, billingWebhookRoutes } from './api/billing';

// Services
import { initializeQueue } from './queue/worker';
import { PreviewManager } from './services/preview/manager';

// =============================================================================
// APP SETUP
// =============================================================================

const app = new Hono();

// Global middleware
app.use('*', honoLogger());
app.use('*', cors({
  origin: env.CORS_ORIGINS,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Stripe webhook — must be BEFORE auth middleware (raw body, no JWT)
app.route('/api/billing/webhook', billingWebhookRoutes);

// Health check (unauthenticated)
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    version: env.VERSION,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// AUTHENTICATED ROUTES
// =============================================================================

const api = new Hono();

// JWT verification middleware — verifies Firebase ID tokens
api.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    c.set('userId', decoded.uid);
    c.set('user', decoded);
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }

  await next();
});

// Mount routes
api.route('/workspace', workspaceRoutes);
api.route('/generate', generateRoutes);
api.route('/preview', previewRoutes);
api.route('/credits', creditRoutes);
api.route('/billing', billingRoutes);

app.route('/api', api);

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.onError((err, c) => {
  logger.error({ err, path: c.req.path }, 'Unhandled error');
  return c.json({
    error: 'Internal server error',
    message: env.NODE_ENV === 'development' ? err.message : undefined,
  }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// =============================================================================
// STARTUP
// =============================================================================

async function start() {
  logger.info('Starting Buildable Backend...');
  
  // Initialize job queue
  await initializeQueue();
  logger.info('Job queue initialized');
  
  // Initialize preview manager
  await PreviewManager.initialize();
  logger.info('Preview manager initialized');
  
  return app;
}

// Start the server
const port = Number(env.PORT) || 3000;

start()
  .then(() => {
    logger.info({ port }, `Server listening on port ${port}`);
    Bun.serve({
      port,
      fetch: app.fetch,
    });
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  });

