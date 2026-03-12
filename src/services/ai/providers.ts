// =============================================================================
// AI Provider Factory
// =============================================================================
// Returns a unified interface for calling Claude or OpenAI based on env config.
// Claude (Anthropic) is the primary provider. OpenAI is the fallback.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { env } from '../../config/env';
import { aiLogger as logger } from '../../utils/logger';

export type Provider = 'anthropic' | 'openai';

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  content: string;
  provider: Provider;
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

// ─── Resolve which provider to use ───────────────────────────────────────────

export function resolveProvider(): Provider {
  // Explicit override
  if (env.DEFAULT_AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.DEFAULT_AI_PROVIDER === 'openai'    && env.OPENAI_API_KEY)    return 'openai';

  // Auto-select: prefer Claude if key is present
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY)    return 'openai';

  throw new Error('No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}

export function resolveModel(role: 'architect' | 'coder', provider: Provider): string {
  if (role === 'architect') {
    if (provider === 'anthropic') return env.DEFAULT_ARCHITECT_MODEL || 'claude-sonnet-4-6';
    return env.DEFAULT_ARCHITECT_MODEL || 'gpt-4o';
  }
  if (provider === 'anthropic') return env.DEFAULT_CODER_MODEL || 'claude-sonnet-4-6';
  return env.DEFAULT_CODER_MODEL || 'gpt-4o';
}

// ─── Unified AI call ──────────────────────────────────────────────────────────

export async function callAI(options: AIRequestOptions): Promise<AIResponse> {
  const provider = resolveProvider();

  logger.info({ provider, model: options.model }, 'AI call');

  if (provider === 'anthropic') {
    return callClaude(options);
  }
  return callOpenAI(options);
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function callClaude(options: AIRequestOptions): Promise<AIResponse> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = options.model ?? 'claude-sonnet-4-6';

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
    provider: 'anthropic',
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI(options: AIRequestOptions): Promise<AIResponse> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const model = options.model ?? 'gpt-4o';

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: options.system },
      ...options.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ],
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 8000,
    ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('No response from OpenAI');

  return {
    content,
    provider: 'openai',
    model,
    inputTokens:  response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  };
}
