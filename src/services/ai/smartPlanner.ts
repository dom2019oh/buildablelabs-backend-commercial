// =============================================================================
// Smart Planner — Determines which files need to change for a given request
// =============================================================================
// Runs BEFORE the coder in edit/iterate mode. Uses a fast model (Haiku) to
// analyse the existing codebase and produce a minimal, targeted change plan.
// Falls back to full_rebuild only when the request rewrites everything.

import { callAI, resolveModel, type StageUsage } from './providers';
import { aiLogger as logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface SmartChange {
  path: string;
  action: 'update' | 'create';
  instructions: string;
}

export interface SmartPlan {
  strategy: 'smart' | 'full_rebuild';
  reason: string;
  changes: SmartChange[];
}

export interface ExistingFile {
  file_path: string;
  content: string;
}

const smartPlanSchema = {
  strategy: (v: unknown): v is 'smart' | 'full_rebuild' => v === 'smart' || v === 'full_rebuild',
  reason:   (v: unknown): v is string => typeof v === 'string',
  changes:  (v: unknown): v is SmartChange[] => Array.isArray(v),
};

// =============================================================================
// SMART PLANNER
// =============================================================================

export class SmartPlanner {
  private model: string;

  constructor() {
    // Always use Haiku — this is analysis, not code generation.
    // Haiku is 10x cheaper than Sonnet and fast enough for planning.
    this.model = resolveModel('smart_planner');
  }

  async plan(
    prompt: string,
    existingFiles: ExistingFile[],
  ): Promise<{ plan: SmartPlan; usage: StageUsage }> {

    const codeFiles = existingFiles.filter(f =>
      /\.(py|js|ts|json|txt)$/.test(f.file_path) || f.file_path === '.env.example'
    );

    // Truncate each file to first 600 chars — enough to see structure, not waste tokens
    const filesSummary = codeFiles.map(f => {
      const preview = f.content.length > 600
        ? f.content.slice(0, 600) + '\n... (truncated)'
        : f.content;
      return `### ${f.file_path}\n\`\`\`\n${preview}\n\`\`\``;
    }).join('\n\n');

    const systemPrompt = `You are a code change analyst for Discord bots. Your job: read an existing bot codebase and a user's change request, then decide the minimal set of files that need updating.

RULES:
- Default to "smart" strategy — update only the files that actually need to change
- Only use "full_rebuild" if the user is asking to completely redo the bot or add a whole new architecture that touches every file
- Instructions must be specific and actionable: describe what to add, change, or remove — not vague
- File paths in changes MUST exactly match the existing file paths listed below
- For functionality that requires a brand new file, set action: "create" and describe the file's purpose and what it should contain
- If a command is being added to a cog, say exactly which cog and what the command should do
- If main.py or requirements.txt need updating due to the change, include them too
- Do NOT include files that don't need to change

Output ONLY valid JSON — no markdown fences, no explanation.

JSON structure:
{
  "strategy": "smart" | "full_rebuild",
  "reason": "<one sentence explaining why>",
  "changes": [
    {
      "path": "<exact file path>",
      "action": "update" | "create",
      "instructions": "<specific, detailed instructions for what to add/change/remove in this file>"
    }
  ]
}`;

    const userPrompt = `Existing codebase:\n\n${filesSummary}\n\nUser's request:\n${prompt}\n\nWhich files need to change? Return the JSON plan.`;

    logger.info({ model: this.model, promptLength: prompt.length, existingFileCount: codeFiles.length }, 'Smart planning');

    const response = await callAI({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: this.model,
      maxTokens: 1500,
      temperature: 0.1,
      jsonMode: true,
    });

    let raw = response.content.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const jsonStart = raw.indexOf('{');
    if (jsonStart > 0) raw = raw.slice(jsonStart);

    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Validate and sanitise
    const plan: SmartPlan = {
      strategy: smartPlanSchema.strategy(parsed.strategy) ? parsed.strategy : 'full_rebuild',
      reason:   smartPlanSchema.reason(parsed.reason) ? parsed.reason : 'Defaulting to full rebuild',
      changes:  smartPlanSchema.changes(parsed.changes)
        ? (parsed.changes as SmartChange[]).filter(
            c => typeof c.path === 'string' && typeof c.instructions === 'string'
          )
        : [],
    };

    const usage: StageUsage = {
      stage: 'smart_planner' as StageUsage['stage'],
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      cacheReadTokens: response.cacheReadTokens,
      costUsd: response.costUsd,
    };

    logger.info({
      strategy: plan.strategy,
      reason: plan.reason,
      changesCount: plan.changes.length,
      changes: plan.changes.map(c => `${c.action}:${c.path}`),
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: `$${response.costUsd.toFixed(6)}`,
    }, 'Smart plan created');

    return { plan, usage };
  }
}
