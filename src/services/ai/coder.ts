// =============================================================================
// Coder Service — Discord Bot Code Generation Phase
// =============================================================================
// Generates individual bot files based on the architect's plan.
// Supports Python (discord.py), JavaScript and TypeScript (discord.js v14).
// Primary provider: Claude (Anthropic). Fallback: OpenAI.

import { aiLogger as logger } from '../../utils/logger';
import { callAI, resolveModel, resolveProvider } from './providers';
import type { ProjectPlan } from './pipeline';

// =============================================================================
// TYPES
// =============================================================================

interface FileSpec {
  path: string;
  purpose: string;
  dependencies: string[];
}

interface ExistingFile {
  file_path: string;
  content: string;
}

// =============================================================================
// SYSTEM PROMPTS PER LANGUAGE
// =============================================================================

const SYSTEM_PROMPTS: Record<string, string> = {
  python: `You are an expert Discord bot developer specialising in Python and discord.py.
Generate clean, production-ready Python bot code.

Rules:
1. Output ONLY the raw file content — no markdown fences, no explanation
2. Use discord.py (import discord / from discord.ext import commands)
3. Use the Cog pattern for all feature files (class MyCog(commands.Cog))
4. Use python-dotenv to load BOT_TOKEN and other secrets from .env
5. Add async/await correctly — all Discord callbacks must be async
6. Handle errors gracefully with try/except and ctx.send() feedback
7. Use type hints throughout
8. Add brief docstrings to commands describing their usage
9. Use discord.Embed for rich responses where appropriate
10. For requirements.txt: list one package per line
11. For .env.example: use placeholder values like YOUR_BOT_TOKEN_HERE`,

  javascript: `You are an expert Discord bot developer specialising in JavaScript and discord.js v14.
Generate clean, production-ready JavaScript bot code.

Rules:
1. Output ONLY the raw file content — no markdown fences, no explanation
2. Use discord.js v14 (const { Client, GatewayIntentBits, ... } = require('discord.js'))
3. Use slash commands (SlashCommandBuilder) for all new commands
4. Store commands in a Collection on the client object
5. Use dotenv to load BOT_TOKEN, CLIENT_ID, GUILD_ID from .env
6. Handle InteractionCreate and ClientReady events
7. Use async/await throughout — handle all Promise rejections
8. Add JSDoc comments to functions
9. For package.json: include name, version, main, scripts.start, and all dependencies
10. For .env.example: use placeholder values like YOUR_BOT_TOKEN_HERE`,

  typescript: `You are an expert Discord bot developer specialising in TypeScript and discord.js v14.
Generate clean, production-ready TypeScript bot code.

Rules:
1. Output ONLY the raw file content — no markdown fences, no explanation
2. Use discord.js v14 with full TypeScript types
3. Use slash commands (SlashCommandBuilder) for all new commands
4. Define proper interfaces and types for all data structures
5. Use dotenv to load BOT_TOKEN, CLIENT_ID, GUILD_ID from .env
6. Extend the Client type to include a commands Collection
7. Use async/await throughout — handle all Promise rejections
8. Add TSDoc comments to all exported functions
9. For package.json: include typescript, ts-node, @types/node as devDependencies
10. For tsconfig.json: target ES2020, module CommonJS, strict true
11. For .env.example: use placeholder values like YOUR_BOT_TOKEN_HERE`,
};

// =============================================================================
// CODER
// =============================================================================

export class Coder {
  private model: string;

  constructor(model?: string) {
    const provider = resolveProvider();
    this.model = model ?? resolveModel('coder', provider);
  }

  async generateFile(
    fileSpec: FileSpec,
    plan: ProjectPlan,
    existingFiles: ExistingFile[],
    originalPrompt: string
  ): Promise<string> {

    const language = (plan as ProjectPlan & { language?: string }).language ?? 'python';

    // Build dependency context
    const dependencyContext = fileSpec.dependencies
      .map(dep => {
        const file = existingFiles.find(f => f.file_path === dep);
        if (!file) return null;
        const fence = language === 'python' ? 'python' : 'javascript';
        return `### ${dep}\n\`\`\`${fence}\n${file.content}\n\`\`\``;
      })
      .filter(Boolean)
      .join('\n\n');

    const otherFiles = existingFiles
      .filter(f => !fileSpec.dependencies.includes(f.file_path))
      .map(f => `- ${f.file_path}`)
      .join('\n');

    const userPrompt = `Generate the file: ${fileSpec.path}

Purpose: ${fileSpec.purpose}

Original user request:
${originalPrompt}

Bot plan:
- Type: ${plan.projectType}
- Language: ${language}
- Description: ${plan.description}
- All planned files: ${plan.files.map(f => f.path).join(', ')}
- Packages required: ${plan.dependencies.join(', ')}

${otherFiles ? `Other files already in the project:\n${otherFiles}` : ''}
${dependencyContext ? `\nDependency files (for context):\n\n${dependencyContext}` : ''}

Generate the complete file content now. Output ONLY the raw file — no markdown, no explanation.`;

    logger.info({
      model: this.model,
      file: fileSpec.path,
      language,
      dependencies: fileSpec.dependencies.length,
    }, 'Generating bot file');

    const systemPrompt = SYSTEM_PROMPTS[language] ?? SYSTEM_PROMPTS['python'];

    const response = await callAI({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: this.model,
      maxTokens: 8000,
      temperature: 0.2,
    });

    // Strip any accidental markdown fences
    let content = response.content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    }

    logger.info({
      file: fileSpec.path,
      provider: response.provider,
      contentLength: content.length,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    }, 'Bot file generated');

    return content;
  }
}
