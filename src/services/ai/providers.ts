// =============================================================================
// AI Provider — Claude (Anthropic) only
// =============================================================================
// All generation goes through Claude Sonnet 4.6.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { aiLogger as logger } from '../../utils/logger';

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AIRequestOptions {
  system: string;
  messages: AIMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

// ─── Model selection ──────────────────────────────────────────────────────────

export function resolveModel(role: 'architect' | 'coder'): string {
  if (role === 'architect') return env.DEFAULT_ARCHITECT_MODEL;
  return env.DEFAULT_CODER_MODEL;
}

// ─── Claude call ─────────────────────────────────────────────────────────────

export async function callAI(options: AIRequestOptions): Promise<AIResponse> {
  const model = options.model ?? 'claude-sonnet-4-6';

  logger.info({ model }, 'Claude AI call');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model,
    system: options.system,
    messages: options.messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: options.maxTokens ?? 8000,
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected Claude response type');
  }

  return {
    content: content.text,
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
