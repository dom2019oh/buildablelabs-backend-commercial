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

  // AI Providers (at least one required)
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_KEY: z.string().optional(),
  
  // Default AI provider and model
  // 'anthropic' = Claude (recommended primary). Falls back automatically if key missing.
  DEFAULT_AI_PROVIDER: z.enum(['openai', 'anthropic', 'google']).default('openai'),
  DEFAULT_ARCHITECT_MODEL: z.string().default('gpt-4o'),
  DEFAULT_CODER_MODEL: z.string().default('gpt-4o'),
  
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
});

// Parse and validate environment
function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  
  // Ensure at least one AI provider is configured
  const data = parsed.data;
  if (!data.OPENAI_API_KEY && !data.ANTHROPIC_API_KEY && !data.GOOGLE_AI_KEY) {
    console.error('❌ At least one AI provider API key is required');
    console.error('Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_AI_KEY');
    process.exit(1);
  }
  
  return data;
}

export const env = loadEnv();

export type Env = typeof env;
