// =============================================================================
// Architect Service — Discord Bot Planning Phase
// =============================================================================
// Converts a plain-English bot description into a structured build plan.
// Powered by Claude Sonnet 4.6.

import { z } from 'zod';
import { aiLogger as logger } from '../../utils/logger';
import { callAI, resolveModel, type StageUsage } from './providers';
import type { ProjectPlan } from './pipeline';

// =============================================================================
// SCHEMA
// =============================================================================

const botPlanSchema = z.object({
  projectType: z.string(),
  language: z.enum(['python', 'javascript', 'typescript']).default('python'),
  description: z.string(),
  files: z.array(z.object({
    path: z.string(),
    purpose: z.string(),
    dependencies: z.array(z.string()),
  })),
  dependencies: z.array(z.string()),
  commands: z.array(z.object({
    name: z.string(),
    description: z.string(),
    type: z.enum(['prefix', 'slash', 'both']).default('prefix'),
  })).optional(),
  intents: z.array(z.string()).optional(),
});

// =============================================================================
// ARCHITECT
// =============================================================================

export class Architect {
  private model: string;

  constructor(model?: string) {
    this.model = model ?? resolveModel('architect');
  }

  async createPlan(
    prompt: string,
    existingFiles: Array<{ file_path: string; content: string }>
  ): Promise<{ plan: ProjectPlan; usage: StageUsage }> {

    const systemPrompt = `You are a senior Discord bot architect with deep expertise in discord.py 2.x (Python) and discord.js v14 (JavaScript/TypeScript). You design production-quality Discord bots that are well-structured, reliable, and maintainable.

Your job: analyse the user's request and output a JSON build plan. Output ONLY valid JSON — no markdown fences, no explanation, nothing else.

JSON structure:
{
  "projectType": "<see types below>",
  "language": "python" | "javascript" | "typescript",
  "description": "<concise description of what the bot does>",
  "files": [
    {
      "path": "<relative file path>",
      "purpose": "<what this file does and why it exists>",
      "dependencies": ["<other file paths this file imports from>"]
    }
  ],
  "dependencies": ["<pip package or npm package>"],
  "commands": [
    { "name": "<command name>", "description": "<what it does>", "type": "prefix" | "slash" | "both" }
  ],
  "intents": ["<Discord intent names required>"]
}

Project types: "moderation-bot" | "music-bot" | "economy-bot" | "leveling-bot" | "ticket-bot" | "utility-bot" | "welcome-bot" | "games-bot" | "logging-bot" | "role-bot" | "reminder-bot" | "poll-bot" | "stats-bot" | "custom-bot"

--- LANGUAGE SELECTION ---
Default to Python (discord.py 2.x) unless the user specifically asks for JavaScript or TypeScript.

--- REQUIRED FILE SET (Python) ---
Every Python bot MUST include ALL of these files:
1. bot.py               — entry point: intents, cog loading, on_ready, error handler, asyncio.run(main())
2. cogs/<feature>.py    — one cog file per major feature group (NOT one file per command)
3. utils/helpers.py     — shared utility functions, embed builders, formatters (only if needed)
4. config.py            — constants, colour palette, embed footers, timeout values
5. requirements.txt     — all pip dependencies with minimum versions
6. .env.example         — BOT_TOKEN, PREFIX, GUILD_ID and any other secrets with placeholder values

For a bot with multiple features: group related commands into one cog (e.g. all moderation in cogs/moderation.py, all economy in cogs/economy.py).

--- REQUIRED FILE SET (JavaScript/TypeScript) ---
1. src/index.js/ts          — entry point: client setup, event loading, command registration, client.login()
2. src/commands/<name>.js/ts — one file per slash command
3. src/events/<event>.js/ts  — event handlers (ready, interactionCreate, messageCreate, etc.)
4. src/utils/helpers.js/ts   — shared utilities
5. package.json              — name, version, main, scripts.start, all dependencies
6. .env.example              — BOT_TOKEN, CLIENT_ID, GUILD_ID

--- INTENT SELECTION ---
Only include intents the bot actually needs:
- GUILDS — always required (server/channel info)
- GUILD_MESSAGES + MESSAGE_CONTENT — needed to read message content (prefix commands, auto-mod)
- GUILD_MEMBERS — needed to access member lists, join/leave events (privileged)
- GUILD_VOICE_STATES — needed for voice/music bots
- GUILD_MESSAGE_REACTIONS — needed to react to reactions
- DIRECT_MESSAGES — needed for DM support
- GUILD_PRESENCES — needed to see online/offline status (privileged, avoid unless necessary)

--- DEPENDENCIES (Python) ---
Always include: discord.py>=2.3.0, python-dotenv>=1.0.0
Music bots add: yt-dlp>=2024.1.0, PyNaCl>=1.5.0
Database bots add: aiosqlite>=0.19.0 or motor>=3.3.0 (MongoDB async)
Economy/leveling bots add: aiosqlite>=0.19.0

--- QUALITY RULES ---
- Plan for real Discord bot functionality — not toy examples
- Each cog should be substantial (multiple related commands), not a single command per file
- Group commands logically: all music commands in one cog, all moderation in one cog
- Config.py centralises magic numbers and colours so they're easy to customise
- requirements.txt must be complete — the bot must run with just pip install -r requirements.txt
- .env.example must list every environment variable the code uses

Existing files in this project:
${existingFiles.map(f => f.file_path).join('\n') || 'None (new project)'}

Output ONLY valid JSON.`;

    const userPrompt = `Plan a Discord bot for this request:\n\n${prompt}`;

    logger.info({ model: this.model, promptLength: prompt.length }, 'Creating Discord bot plan');

    const response = await callAI({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: this.model,
      maxTokens: 4000,
      temperature: 0.2,
      jsonMode: true,
    });

    // Strip any accidental markdown fences
    let raw = response.content.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    // Find the first { to handle any leading text
    const jsonStart = raw.indexOf('{');
    if (jsonStart > 0) raw = raw.slice(jsonStart);

    const parsed = JSON.parse(raw);
    const validated = botPlanSchema.parse(parsed);

    logger.info({
      model: response.model,
      filesPlanned: validated.files.length,
      language: validated.language,
      projectType: validated.projectType,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      cacheReadTokens: response.cacheReadTokens,
      costUsd: `$${response.costUsd.toFixed(6)}`,
    }, 'Discord bot plan created');

    const usage: StageUsage = {
      stage: 'architect',
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      cacheReadTokens: response.cacheReadTokens,
      costUsd: response.costUsd,
    };

    return { plan: validated as ProjectPlan, usage };
  }
}
