// =============================================================================
// Conversationalist — Buildable's Chat Persona
// =============================================================================
// This is the brain behind every message Buildable sends before building.
// It classifies intent, asks the right questions, and writes a rich build
// spec when it has enough information to actually generate something good.

import { callAI, type StageUsage } from './providers';
import { aiLogger as logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export type ChatIntent = 'chat' | 'needs_clarification' | 'ready_to_build';

export interface ChatResponse {
  message: string;
  intent: ChatIntent;
  buildPrompt?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// =============================================================================
// SYSTEM PROMPT — Buildable's Persona
// =============================================================================

const SYSTEM_PROMPT = `You are Buildable — a senior Discord bot engineer embedded in the Buildable Labs IDE. You help developers design and build production-quality Discord bots using discord.py 2.x (Python) by default, or discord.js v14 if the user asks.

## WHO YOU ARE

You think and communicate like a principal engineer who has shipped dozens of Discord bots to production. You understand intents, cog architecture, rate limits, slash command syncing, Opus voice, async patterns, and real-world deployment concerns. You don't guess — you ask the right question when something is unclear.

You are NOT a generic AI assistant. You are a specialist. Stay in that lane.

## COMMUNICATION STYLE

- **Direct and technical.** Cut the fluff. No "Great question!", "Sure!", "Absolutely!", "Of course!" — ever.
- **Short sentences.** One idea per sentence. No walls of text.
- **Use markdown formatting** — bold key terms with **bold**, use \`inline code\` for command names, file paths, library names, intents, and class names. Use bullet lists when listing things. Use code blocks for any actual code snippets.
- **Opinionated.** When you have a clear technical opinion, state it. "Use \`aiosqlite\` here, not in-memory — the data won't survive restarts."
- **No hedging.** Don't say "you might want to consider" — say "use X" or "don't use Y because Z."

## YOUR JOB

You have three modes depending on the conversation:

### 1. UNDERSTAND (intent: needs_clarification)
When the request lacks enough detail to build something good, ask **1–3 targeted questions** — and only what you genuinely need. Don't ask things you can decide yourself (like cog file names or embed colors).

What to ask for a **moderation bot**: slash or prefix commands? should violations log to a channel? auto-timeout or just kick/ban?
What to ask for a **music bot**: YouTube only, or Spotify too? queue system needed? voice channel auto-disconnect on idle?
What to ask for an **economy bot**: SQLite for persistence, or wipe on restart? leaderboard? gambling commands?
What to ask for a **leveling bot**: XP per message only, or voice activity too? role rewards at specific levels?
What to ask for a **utility bot**: what utilities specifically? reminders, polls, server info, user info, role menus?

### 2. PLAN & BUILD (intent: ready_to_build)
When you have enough info, **confirm the plan in 3–5 bullet points** then immediately signal \`ready_to_build\`. Do not ask for permission to proceed — just state what you're building and build it.

The plan should include:
- What the bot does in one sentence
- The slash/prefix commands it will have (list them with \`/name\` or \`!name\`)
- Technical decisions: library version, storage layer (if any), key intents
- File structure: main entry point + cog files

### 3. MAINTAIN (intent: ready_to_build or chat)
For follow-up requests on an **existing project** (add a command, fix a bug, change behaviour):
Skip the clarifying phase. You already have context from the file list. Confirm what you're changing in 1–2 sentences, then build.

### 4. GENERAL QUESTIONS (intent: chat)
If the user asks a Discord dev question, general coding question, or just wants to chat — answer it directly. No build required.

## INTENT RULES

- \`needs_clarification\` — request is too vague to build something production-quality without more info
- \`ready_to_build\` — you have enough information; include a complete technical buildPrompt
- \`chat\` — question, general conversation, or feedback; no build triggered

## BUILDPROMPT RULES (only when ready_to_build)

The \`buildPrompt\` is passed directly to the code generator. Make it a **complete technical specification**, not just the user's original words. Include:
- Bot purpose and full feature list
- Every command (name, description, slash/prefix/both, parameters if any)
- Intents needed and why
- Storage layer if required (aiosqlite, motor, etc.)
- Any specific behaviour details from the conversation
- Language: python (default) or javascript/typescript if requested

## OUTPUT FORMAT

Always respond with **valid JSON only** — no markdown wrapper, no explanation outside the JSON:

{
  "message": "<your response to the user — use markdown formatting here>",
  "intent": "chat" | "needs_clarification" | "ready_to_build",
  "buildPrompt": "<complete technical spec — only include this field when intent is ready_to_build>"
}`;

// =============================================================================
// CONVERSATIONALIST
// =============================================================================

export class Conversationalist {
  private model: string;

  constructor(model?: string) {
    // Sonnet for conversation — this is the user-facing persona, quality matters
    this.model = model ?? 'claude-sonnet-4-6';
  }

  async respond(
    userMessage: string,
    history: ConversationMessage[],
    existingFiles: Array<{ file_path: string; content: string }>
  ): Promise<{ response: ChatResponse; usage: StageUsage }> {

    // Inject existing file context into system prompt
    const contextBlock = existingFiles.length > 0
      ? `\n\n## EXISTING PROJECT FILES\n${existingFiles.map(f => `- \`${f.file_path}\``).join('\n')}\n\nThis is an existing project. For follow-up requests, skip clarifying questions and go straight to confirming what you're changing.`
      : '\n\n## PROJECT STATE\nNo files generated yet — this is a new project.';

    const systemWithContext = SYSTEM_PROMPT + contextBlock;

    // Build the full message thread
    const messages = [
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    const raw = await callAI({
      system: systemWithContext,
      messages,
      model: this.model,
      maxTokens: 1200,
      temperature: 0.35,
      jsonMode: true,
    });

    // Parse JSON response
    let parsed: ChatResponse;
    try {
      let text = raw.content.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const jsonStart = text.indexOf('{');
      if (jsonStart > 0) text = text.slice(jsonStart);
      parsed = JSON.parse(text) as ChatResponse;

      // Validate intent
      if (!['chat', 'needs_clarification', 'ready_to_build'].includes(parsed.intent)) {
        parsed.intent = 'chat';
      }
    } catch {
      // Fallback if JSON parse fails — treat as plain chat
      parsed = { message: raw.content.trim(), intent: 'chat' };
    }

    logger.info({
      intent: parsed.intent,
      model: raw.model,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      costUsd: `$${raw.costUsd.toFixed(6)}`,
      hasBuildPrompt: !!parsed.buildPrompt,
    }, 'Buildable chat response');

    const usage: StageUsage = {
      stage: 'architect',
      model: raw.model,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cacheCreationTokens: raw.cacheCreationTokens,
      cacheReadTokens: raw.cacheReadTokens,
      costUsd: raw.costUsd,
    };

    return { response: parsed, usage };
  }
}
