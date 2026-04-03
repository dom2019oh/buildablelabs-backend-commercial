// =============================================================================
// Environment Configuration
// =============================================================================

import { z } from 'zod';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  VERSION: z.string().default('1.0.0'),
  CORS_ORIGINS: z.string().transform((s) => s.split(',')).default('*'),

  // Firebase Admin (for JWT verification)
  FIREBASE_PROJECT_ID: z.string().min(1),
  // Base64-encoded service account JSON from Firebase console
  FIREBASE_SERVICE_ACCOUNT_KEY: z.string().min(1),

  // Anthropic — Claude is the only AI provider
  ANTHROPIC_API_KEY: z.string().min(1),

  // Model overrides (defaults to claude-sonnet-4-6)
  DEFAULT_ARCHITECT_MODEL: z.string().default('claude-sonnet-4-6'),
  DEFAULT_CODER_MODEL: z.string().default('claude-sonnet-4-6'),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_REDIRECT_BASE: z.string().default('https://dashboard.buildablelabs.dev'),

  // Preview Server
  PREVIEW_BASE_PORT: z.coerce.number().default(3100),
  PREVIEW_HOST: z.string().default('localhost'),
  PREVIEW_MAX_SERVERS: z.coerce.number().default(10),

  // Redis (for queue)
  REDIS_URL: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Debug log endpoint secret (set in Railway)
  DEBUG_SECRET: z.string().default('buildable-debug-2026'),

  // Admin email — used to grant admin custom claim (set in Railway)
  ADMIN_EMAIL: z.string().optional(),
});

// Parse and validate environment
function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export type Env = typeof env;
