// =============================================================================
// Validator Service — AI-Powered Code Review
// =============================================================================
// Uses Claude to review generated bot files for critical bugs and missing pieces.
// Token-efficient: one pass over all files, outputs only what needs fixing.

import { callAI } from './providers';
import { aiLogger as logger } from '../../utils/logger';
import { env } from '../../config/env';

// =============================================================================
// TYPES
// =============================================================================

interface ValidationFile {
  file_path: string;
  content: string;
}

interface ValidationError {
  file: string;
  message: string;
  severity: 'error' | 'warning';
}

interface Repair {
  filePath: string;
  content: string;
  reason: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  repairs: Repair[];
}

// =============================================================================
// VALIDATOR
// =============================================================================

export class Validator {
  async validate(files: ValidationFile[]): Promise<ValidationResult> {
    if (files.length === 0) {
      return { valid: true, errors: [], warnings: [], repairs: [] };
    }

    const codeFiles = files.filter(f => this.isCodeFile(f.file_path));
    if (codeFiles.length === 0) {
      return { valid: true, errors: [], warnings: [], repairs: [] };
    }

    try {
      const repairs = await this.aiReview(files);

      logger.info({
        totalFiles: files.length,
        repairs: repairs.length,
      }, 'AI validation complete');

      return {
        valid: repairs.length === 0,
        errors: repairs.map(r => ({ file: r.filePath, message: r.reason, severity: 'error' as const })),
        warnings: [],
        repairs,
      };
    } catch (err) {
      logger.warn({ err }, 'AI validation failed — skipping repairs');
      return { valid: true, errors: [], warnings: [], repairs: [] };
    }
  }

  private isCodeFile(filePath: string): boolean {
    return /\.(py|js|ts|json|txt|env\.example)$/.test(filePath) ||
           filePath === '.env.example' ||
           filePath === 'requirements.txt' ||
           filePath === 'package.json';
  }

  private async aiReview(files: ValidationFile[]): Promise<Repair[]> {
    // Build a compact representation of all files
    const filesSummary = files.map(f => {
      // Truncate very large files for the review — we only need enough to spot bugs
      const content = f.content.length > 3000
        ? f.content.slice(0, 3000) + '\n... (truncated)'
        : f.content;
      return `### ${f.file_path}\n\`\`\`\n${content}\n\`\`\``;
    }).join('\n\n');

    const systemPrompt = `You are a senior Discord bot code reviewer. Your job is to find CRITICAL bugs in generated Discord bot files and return fixed versions.

Only report and fix CRITICAL issues:
- Missing \`async def setup(bot)\` at the bottom of cog files
- Missing \`asyncio.run(main())\` or \`bot.run()\` in bot.py
- Missing \`load_dotenv()\` in bot.py
- Incorrect \`bot.load_extension()\` call format
- Broken cog class structure (missing __init__, wrong inheritance)
- Missing \`await\` on async calls
- Missing \`if __name__ == '__main__':\` guard in bot.py
- Invalid discord.py 2.x imports (e.g. using discord.py 1.x patterns)
- Missing \`client.login()\` in discord.js entry files
- requirements.txt missing essential packages (discord.py, python-dotenv)
- .env.example missing BOT_TOKEN

DO NOT report: style issues, console.log warnings, type hints, comment quality, or anything subjective.

Respond with ONLY a JSON array. If everything is correct, return [].
If fixes are needed:
[
  {
    "filePath": "path/to/file.py",
    "content": "<complete corrected file content>",
    "reason": "<one-line description of what was fixed>"
  }
]

Output ONLY the JSON array — no explanation, no markdown.`;

    const response = await callAI({
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Review these Discord bot files for critical bugs:\n\n${filesSummary}\n\nReturn a JSON array of repairs needed, or [] if everything looks correct.`,
      }],
      model: env.DEFAULT_CODER_MODEL,
      maxTokens: 8000,
      temperature: 0.1,
    });

    let raw = response.content.trim();
    // Strip markdown fences if present
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    // Find JSON array
    const arrayStart = raw.indexOf('[');
    if (arrayStart > 0) raw = raw.slice(arrayStart);

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((r: unknown) =>
      r &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>).filePath === 'string' &&
      typeof (r as Record<string, unknown>).content === 'string'
    ) as Repair[];
  }
}
