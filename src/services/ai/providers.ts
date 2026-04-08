// =============================================================================
// AI Provider — Claude (Anthropic) only
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { aiLogger as logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface AIRequestOptions {
  system: string;
  messages: AIMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

/** Per-stage usage summary returned by each AI service. */
export interface StageUsage {
  stage: 'architect' | 'coder' | 'validator' | 'smart_planner';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** For coder: number of files generated in this stage. */
  filesGenerated?: number;
}

// =============================================================================
// PRICING  (per 1 M tokens, USD)
// Source: https://www.anthropic.com/pricing  — updated 2025-04
// =============================================================================

const PRICING: Record<string, {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}> = {
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00,  cacheWrite: 1.00, cacheRead: 0.08 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-6'];
  const M = 1_000_000;
  return (
    (inputTokens        / M) * p.input +
    (outputTokens       / M) * p.output +
    (cacheCreationTokens / M) * p.cacheWrite +
    (cacheReadTokens    / M) * p.cacheRead
  );
}

// =============================================================================
// MODEL SELECTION
// =============================================================================

export function resolveModel(role: 'architect' | 'coder' | 'validator' | 'smart_planner'): string {
  if (role === 'architect')    return env.DEFAULT_ARCHITECT_MODEL;
  if (role === 'validator')    return env.DEFAULT_VALIDATOR_MODEL;
  if (role === 'smart_planner') return env.DEFAULT_VALIDATOR_MODEL; // Haiku — fast analysis, not code gen
  return env.DEFAULT_CODER_MODEL;
}

// =============================================================================
// CLAUDE CALL — with prompt caching on all system prompts
// =============================================================================

export async function callAI(options: AIRequestOptions): Promise<AIResponse> {
  const model = options.model ?? 'claude-sonnet-4-6';

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const systemBlock: any = [{
    type: 'text',
    text: options.system,
    cache_control: { type: 'ephemeral' },
  }];

  const response = await client.messages.create({
    model,
    // Cache the system prompt — fully static per stage/language.
    // First call pays cache-write price; all subsequent calls within the 5-min
    // TTL pay cache-read price (~10× cheaper than full input).
    system: systemBlock,
    messages: options.messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: options.maxTokens ?? 8000,
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected Claude response type');
  }

  const inputTokens          = response.usage.input_tokens;
  const outputTokens         = response.usage.output_tokens;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usageAny = response.usage as any;
  const cacheCreationTokens  = usageAny.cache_creation_input_tokens ?? 0;
  const cacheReadTokens      = usageAny.cache_read_input_tokens     ?? 0;
  const costUsd              = calculateCost(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

  logger.info({
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    cacheHit: cacheReadTokens > 0,
    costUsd: `$${costUsd.toFixed(6)}`,
  }, 'Claude call complete');

  return {
    content: content.text,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costUsd,
  };
}
