// =============================================================================
// Architect Service — Discord Bot Planning Phase
// =============================================================================
// Converts a plain-English bot description into a structured build plan:
// language, files, commands, intents, and dependencies.
// No code is generated here — only planning.

import { z } from 'zod';
import { aiLogger as logger } from '../../utils/logger';
import { callAI, resolveModel, resolveProvider } from './providers';
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
    type: z.enum(['prefix', 'slash']).default('prefix'),
  })).optional(),
  intents: z.array(z.string()).optional(),
  routes: z.array(z.string()).optional(),
});

// =============================================================================
// ARCHITECT
// =============================================================================

export class Architect {
  private model: string;

  constructor(model?: string) {
    const provider = resolveProvider();
    this.model = model ?? resolveModel('architect', provider);
  }

  async createPlan(
    prompt: string,
    existingFiles: Array<{ file_path: string; content: string }>
  ): Promise<ProjectPlan> {

    const systemPrompt = `You are an expert Discord bot architect. Your job is to analyse a user's plain-English bot request and produce a structured JSON build plan.

You must output ONLY a valid JSON object — no markdown, no explanation — with this structure:

{
  "projectType": "music-bot" | "moderation-bot" | "economy-bot" | "leveling-bot" | "ticket-bot" | "utility-bot" | "welcome-bot" | "custom-bot",
  "language": "python" | "javascript" | "typescript",
  "description": "Concise description of what the bot does",
  "files": [
    {
      "path": "bot.py",
      "purpose": "Main entry point — loads cogs, sets up intents, runs the bot",
      "dependencies": []
    },
    {
      "path": "cogs/music.py",
      "purpose": "Music cog — play, queue, skip, shuffle, nowplaying commands",
      "dependencies": ["bot.py"]
    }
  ],
  "dependencies": ["discord.py", "yt-dlp", "python-dotenv"],
  "commands": [
    { "name": "play",  "description": "Play a song from YouTube", "type": "prefix" },
    { "name": "skip",  "description": "Skip current track",        "type": "prefix" }
  ],
  "intents": ["GUILDS", "GUILD_MESSAGES", "GUILD_VOICE_STATES", "MESSAGE_CONTENT"]
}

Language selection rules:
- Default to Python (discord.py) unless the user specifically requests JavaScript or TypeScript
- For Python: use cogs/extensions per feature area, python-dotenv for config
- For JavaScript/TypeScript: use discord.js v14, separate command files in /commands

File structure rules (Python):
- bot.py            — entry point, loads cogs, configures intents
- cogs/<feature>.py — one cog per major feature (music, moderation, economy, etc.)
- utils/helpers.py  — shared utility functions if needed
- .env.example      — BOT_TOKEN, PREFIX, GUILD_ID placeholders
- requirements.txt  — all pip dependencies

File structure rules (JavaScript/TypeScript):
- index.js/ts              — entry point, loads commands and events
- commands/<name>.js/ts    — one file per slash/prefix command
- events/<event>.js/ts     — event handlers (ready, messageCreate, etc.)
- utils/helpers.js/ts      — shared utilities
- .env.example             — BOT_TOKEN, CLIENT_ID, GUILD_ID
- package.json             — with all npm dependencies

Existing files in this project:
${existingFiles.map(f => f.file_path).join('\n') || 'None (new project)'}

Output ONLY valid JSON.`;

    const userPrompt = `Create a Discord bot build plan for:\n\n${prompt}`;

    logger.info({ model: this.model, promptLength: prompt.length }, 'Creating Discord bot plan');

    const response = await callAI({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: this.model,
      maxTokens: 4000,
      temperature: 0.4,
      jsonMode: true,
    });

    // Strip any accidental markdown code fences
    let raw = response.content.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(raw);
    const validated = botPlanSchema.parse(parsed);

    logger.info({
      provider: response.provider,
      filesPlanned: validated.files.length,
      language: validated.language,
      projectType: validated.projectType,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    }, 'Discord bot plan created');

    return validated as ProjectPlan;
  }
}
