// =============================================================================
// AI Generation Pipeline
// =============================================================================
// Orchestrates the full generation flow:
// 1. ARCHITECT - Parse intent and create structured plan
// 2. SCAFFOLD - Set up project structure from templates
// 3. GENERATE - Create files iteratively with full context
// 4. VALIDATE - Check for errors and fix issues

import { aiLogger as logger } from '../../utils/logger';
import * as db from '../../db/queries';
import { Architect } from './architect';
import { Coder } from './coder';
import { Validator } from './validator';
import { SmartPlanner } from './smartPlanner';
import { env } from '../../config/env';
import type { StageUsage } from './providers';

// ─── Cost accumulator ────────────────────────────────────────────────────────

function zeroCost(stage: StageUsage['stage'], model: string): StageUsage {
  return { stage, model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

function addUsage(acc: StageUsage, u: StageUsage): StageUsage {
  return {
    ...acc,
    inputTokens:         acc.inputTokens         + u.inputTokens,
    outputTokens:        acc.outputTokens        + u.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
    cacheReadTokens:     acc.cacheReadTokens     + u.cacheReadTokens,
    costUsd:             acc.costUsd             + u.costUsd,
  };
}

function buildCostPayload(stages: StageUsage[]) {
  const totals = stages.reduce(
    (acc, s) => ({
      inputTokens:         acc.inputTokens         + s.inputTokens,
      outputTokens:        acc.outputTokens        + s.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + s.cacheCreationTokens,
      cacheReadTokens:     acc.cacheReadTokens     + s.cacheReadTokens,
      costUsd:             acc.costUsd             + s.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  );

  const breakdown: Record<string, object> = {};
  for (const s of stages) {
    breakdown[s.stage] = {
      model:               s.model,
      input_tokens:        s.inputTokens,
      output_tokens:       s.outputTokens,
      cache_creation_tokens: s.cacheCreationTokens,
      cache_read_tokens:   s.cacheReadTokens,
      cost_usd:            +s.costUsd.toFixed(6),
      ...(s.filesGenerated !== undefined ? { files_generated: s.filesGenerated } : {}),
    };
  }

  return {
    cost_usd: +totals.costUsd.toFixed(6),
    cost_breakdown: breakdown,
    tokens_total: {
      input:          totals.inputTokens,
      output:         totals.outputTokens,
      cache_creation: totals.cacheCreationTokens,
      cache_read:     totals.cacheReadTokens,
    },
  };
}

// =============================================================================
// TYPES
// =============================================================================

export type WorkspaceMode = 'plan' | 'architect' | 'build';

export interface PipelineOptions {
  workspaceId: string;
  userId: string;
  sessionId: string;
  prompt: string;
  mode?: WorkspaceMode;
  /** True when code files already exist — triggers Smart Task instead of full rebuild */
  hasExistingCode?: boolean;
  options?: {
    template?: string;
    model?: string;
  };
}

export interface ProjectPlan {
  projectType: string;
  description: string;
  files: Array<{
    path: string;
    purpose: string;
    dependencies: string[];
  }>;
  dependencies: string[];
  routes?: string[];
}

// =============================================================================
// PIPELINE
// =============================================================================

export class GenerationPipeline {
  private workspaceId: string;
  private userId: string;
  private sessionId: string;
  private prompt: string;
  private mode: WorkspaceMode;
  private hasExistingCode: boolean;
  private options: PipelineOptions['options'];

  constructor(config: PipelineOptions) {
    this.workspaceId = config.workspaceId;
    this.userId = config.userId;
    this.sessionId = config.sessionId;
    this.prompt = config.prompt;
    this.mode = config.mode ?? 'build';
    this.hasExistingCode = config.hasExistingCode ?? false;
    this.options = config.options;
  }

  async run(): Promise<void> {
    const startTime = Date.now();

    try {
      if (this.mode === 'plan') {
        await this.runPlanMode(startTime);
      } else if (this.mode === 'architect') {
        await this.runArchitectMode(startTime);
      } else if (this.hasExistingCode) {
        await this.runSmartMode(startTime);
      } else {
        await this.runBuildMode(startTime);
      }
    } catch (error) {
      logger.error({ error, sessionId: this.sessionId }, 'Pipeline failed');

      await db.updateSession(this.sessionId, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        completed_at: new Date().toISOString(),
      });

      await db.updateWorkspaceStatus(this.workspaceId, 'error');

      throw error;
    }
  }

  // ===========================================================================
  // PLAN MODE — Architect only: create plan, write PLAN.md, no code generated
  // ===========================================================================

  private async runPlanMode(startTime: number): Promise<void> {
    logger.info({ sessionId: this.sessionId }, '[Plan Mode] Starting planning phase');

    await db.updateSession(this.sessionId, { status: 'planning' });

    const architect = new Architect(this.options?.model ?? env.DEFAULT_ARCHITECT_MODEL);
    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    const { plan, usage: architectUsage } = await architect.createPlan(this.prompt, existingFiles);

    await db.updateSession(this.sessionId, {
      plan: plan as unknown as object,
      files_planned: plan.files.length,
    });

    // Write a human-readable PLAN.md so it appears in the file explorer
    const planContent = this.formatPlanAsMarkdown(plan);
    await db.upsertFile(this.workspaceId, this.userId, 'PLAN.md', planContent);

    const duration = Date.now() - startTime;
    const costPayload = buildCostPayload([architectUsage]);

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: 1,
      completed_at: new Date().toISOString(),
      ...costPayload,
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({ sessionId: this.sessionId, durationMs: duration, ...costPayload }, '[Plan Mode] Plan created');
  }

  // ===========================================================================
  // ARCHITECT MODE — Plan + architecture docs + Mermaid diagrams
  // ===========================================================================

  private async runArchitectMode(startTime: number): Promise<void> {
    logger.info({ sessionId: this.sessionId }, '[Architect Mode] Starting architecture phase');

    await db.updateSession(this.sessionId, { status: 'planning' });

    const architect = new Architect(this.options?.model ?? env.DEFAULT_ARCHITECT_MODEL);
    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    const { plan, usage: architectUsage } = await architect.createPlan(this.prompt, existingFiles);

    await db.updateSession(this.sessionId, {
      plan: plan as unknown as object,
      files_planned: plan.files.length,
    });

    // Generate ARCHITECTURE.md with Mermaid diagrams
    const archContent = this.formatArchitectureDoc(plan);
    await db.upsertFile(this.workspaceId, this.userId, 'ARCHITECTURE.md', archContent);

    // Generate PLAN.md as well
    const planContent = this.formatPlanAsMarkdown(plan);
    await db.upsertFile(this.workspaceId, this.userId, 'PLAN.md', planContent);

    const duration = Date.now() - startTime;
    const costPayload = buildCostPayload([architectUsage]);

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: 2,
      completed_at: new Date().toISOString(),
      ...costPayload,
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({ sessionId: this.sessionId, durationMs: duration, ...costPayload }, '[Architect Mode] Architecture docs created');
  }

  // ===========================================================================
  // SMART MODE — Targeted edits: plan only changed files → update them → validate
  // ===========================================================================
  // Used when existing code files are present. Instead of rebuilding everything,
  // a SmartPlanner determines which 1-3 files need to change, then only those
  // files are regenerated. Falls back to full BUILD MODE if needed.

  private async runSmartMode(startTime: number): Promise<void> {
    logger.info({ sessionId: this.sessionId }, '[Smart Mode] Analysing changes needed');

    await db.updateSession(this.sessionId, { status: 'planning' });

    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    // ── Stage 1: Smart Planner ────────────────────────────────────────────────
    const planner = new SmartPlanner();
    const { plan: smartPlan, usage: plannerUsage } = await planner.plan(this.prompt, existingFiles);

    logger.info({
      sessionId: this.sessionId,
      strategy: smartPlan.strategy,
      reason: smartPlan.reason,
      changes: smartPlan.changes.map(c => `${c.action}:${c.path}`),
    }, '[Smart Mode] Plan ready');

    // If the planner decides a full rebuild is needed, delegate to BUILD MODE
    if (smartPlan.strategy === 'full_rebuild') {
      logger.info({ sessionId: this.sessionId }, '[Smart Mode] Falling back to full build mode');
      await this.runBuildMode(startTime);
      return;
    }

    if (smartPlan.changes.length === 0) {
      logger.warn({ sessionId: this.sessionId }, '[Smart Mode] No changes identified — completing as-is');
      await db.updateSession(this.sessionId, {
        status: 'completed',
        files_generated: 0,
        completed_at: new Date().toISOString(),
        cost_usd: plannerUsage.costUsd,
        cost_breakdown: { smart_planner: { model: plannerUsage.model, cost_usd: plannerUsage.costUsd } },
        tokens_total: { input: plannerUsage.inputTokens, output: plannerUsage.outputTokens, cache_creation: 0, cache_read: 0 },
      });
      await db.updateWorkspaceStatus(this.workspaceId, 'ready');
      return;
    }

    await db.updateSession(this.sessionId, {
      files_planned: smartPlan.changes.length,
      status: 'generating',
    });

    // ── Stage 2: Targeted Code Generation ────────────────────────────────────
    const coder = new Coder(this.options?.model ?? env.DEFAULT_CODER_MODEL);
    let filesGenerated = 0;
    let coderUsage = { stage: 'coder' as const, model: this.options?.model ?? env.DEFAULT_CODER_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 };

    const changedFilePaths: string[] = [];

    for (const change of smartPlan.changes) {
      try {
        // Always re-fetch current files so each iteration has fresh content
        const currentFiles = await db.getWorkspaceFiles(this.workspaceId);

        const { content, usage: fileUsage } = await coder.smartUpdateFile(
          change.path,
          change.instructions,
          currentFiles,
          this.prompt,
          change.action,
        );

        coderUsage = addUsage(coderUsage, fileUsage);

        const existingFile = currentFiles.find(f => f.file_path === change.path);
        await db.recordFileOperation(
          this.workspaceId,
          this.userId,
          this.sessionId,
          change.action === 'create' ? 'create' : 'update',
          change.path,
          {
            previousContent: existingFile?.content,
            newContent: content,
            aiModel: fileUsage.model,
            aiReasoning: change.instructions.slice(0, 200),
          }
        );

        await db.upsertFile(this.workspaceId, this.userId, change.path, content);

        filesGenerated++;
        changedFilePaths.push(change.path);
        await db.updateSession(this.sessionId, { files_generated: filesGenerated });

        logger.info({
          sessionId: this.sessionId,
          file: change.path,
          action: change.action,
          progress: `${filesGenerated}/${smartPlan.changes.length}`,
        }, '[Smart Mode] File updated');

      } catch (fileError) {
        logger.error({
          error: fileError,
          file: change.path,
          sessionId: this.sessionId,
        }, '[Smart Mode] Failed to update file');
      }
    }

    coderUsage.filesGenerated = filesGenerated;

    // ── Stage 3: Targeted Validation (changed files only) ─────────────────────
    await db.updateSession(this.sessionId, { status: 'validating' });

    const validator = new Validator();
    const allFiles = await db.getWorkspaceFiles(this.workspaceId);

    // Only validate the files we just changed — not the whole codebase
    const filesToValidate = allFiles.filter(f => changedFilePaths.includes(f.file_path));
    const validationResult = await validator.validate(filesToValidate);
    const { usage: validatorUsage } = validationResult;

    if (validationResult.repairs.length > 0) {
      logger.warn({
        sessionId: this.sessionId,
        repairs: validationResult.repairs.map(r => r.filePath),
      }, '[Smart Mode] Auto-repairing issues found by validator');

      for (const repair of validationResult.repairs) {
        await db.upsertFile(this.workspaceId, this.userId, repair.filePath, repair.content);
      }
    }

    const duration = Date.now() - startTime;
    const costPayload = buildCostPayload([plannerUsage, coderUsage, validatorUsage]);

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: filesGenerated,
      file_paths: changedFilePaths,
      completed_at: new Date().toISOString(),
      ...costPayload,
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({
      sessionId: this.sessionId,
      filesUpdated: filesGenerated,
      changedFiles: changedFilePaths,
      durationMs: duration,
      costUsd: `$${costPayload.cost_usd.toFixed(6)}`,
    }, '[Smart Mode] Completed');
  }

  // ===========================================================================
  // BUILD MODE — Full pipeline: plan → scaffold → generate → validate
  // ===========================================================================

  private async runBuildMode(startTime: number): Promise<void> {
    // PHASE 1: ARCHITECT
    logger.info({ sessionId: this.sessionId }, 'Phase 1: Architect - Planning');

    await db.updateSession(this.sessionId, { status: 'planning' });

    const architect = new Architect(this.options?.model ?? env.DEFAULT_ARCHITECT_MODEL);
    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    const { plan, usage: architectUsage } = await architect.createPlan(this.prompt, existingFiles);

    await db.updateSession(this.sessionId, {
      plan: plan as unknown as object,
      files_planned: plan.files.length,
    });

    logger.info({ sessionId: this.sessionId, filesPlanned: plan.files.length }, 'Plan created');

    // PHASE 2: SCAFFOLDING
    logger.info({ sessionId: this.sessionId }, 'Phase 2: Scaffolding');

    await db.updateSession(this.sessionId, { status: 'scaffolding' });

    if (this.options?.template) {
      await this.applyTemplate(this.options.template);
    }

    // PHASE 3: GENERATION
    logger.info({ sessionId: this.sessionId }, 'Phase 3: Generating files');

    await db.updateSession(this.sessionId, { status: 'generating' });

    const coder = new Coder(this.options?.model ?? env.DEFAULT_CODER_MODEL);
    let filesGenerated = 0;
    const generatedFilePaths: string[] = [];
    let coderUsage = zeroCost('coder', this.options?.model ?? env.DEFAULT_CODER_MODEL);

    for (const fileSpec of plan.files) {
      try {
        const currentFiles = await db.getWorkspaceFiles(this.workspaceId);

        const { content, usage: fileUsage } = await coder.generateFile(
          fileSpec,
          plan,
          currentFiles,
          this.prompt
        );

        coderUsage = addUsage(coderUsage, fileUsage);

        const existingFile = currentFiles.find(f => f.file_path === fileSpec.path);
        await db.recordFileOperation(
          this.workspaceId,
          this.userId,
          this.sessionId,
          existingFile ? 'update' : 'create',
          fileSpec.path,
          {
            previousContent: existingFile?.content,
            newContent: content,
            aiModel: fileUsage.model,
            aiReasoning: fileSpec.purpose,
          }
        );

        await db.upsertFile(this.workspaceId, this.userId, fileSpec.path, content);

        filesGenerated++;
        generatedFilePaths.push(fileSpec.path);
        await db.updateSession(this.sessionId, { files_generated: filesGenerated });

        logger.info({
          sessionId: this.sessionId,
          file: fileSpec.path,
          progress: `${filesGenerated}/${plan.files.length}`,
        }, 'File generated');

      } catch (fileError) {
        logger.error({
          error: fileError,
          file: fileSpec.path,
          sessionId: this.sessionId,
        }, 'Failed to generate file');
      }
    }

    coderUsage.filesGenerated = filesGenerated;

    // PHASE 4: VALIDATION
    logger.info({ sessionId: this.sessionId }, 'Phase 4: Validating');

    await db.updateSession(this.sessionId, { status: 'validating' });

    const validator = new Validator();
    const allFiles = await db.getWorkspaceFiles(this.workspaceId);

    const validationResult = await validator.validate(allFiles);
    const { usage: validatorUsage } = validationResult;

    if (validationResult.errors.length > 0) {
      logger.warn({
        sessionId: this.sessionId,
        errors: validationResult.errors,
      }, 'Validation found issues, attempting auto-repair');

      for (const repair of validationResult.repairs) {
        await db.upsertFile(this.workspaceId, this.userId, repair.filePath, repair.content);
      }
    }

    const duration = Date.now() - startTime;
    const costPayload = buildCostPayload([architectUsage, coderUsage, validatorUsage]);

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: filesGenerated,
      file_paths: generatedFilePaths,
      completed_at: new Date().toISOString(),
      ...costPayload,
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({
      sessionId: this.sessionId,
      filesGenerated,
      durationMs: duration,
      costUsd: `$${costPayload.cost_usd.toFixed(6)}`,
      cacheReadTokens: costPayload.tokens_total.cache_read,
    }, 'Generation completed');
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private formatPlanAsMarkdown(plan: ProjectPlan): string {
    const fileList = plan.files
      .map(f => `- **${f.path}** — ${f.purpose}`)
      .join('\n');

    const deps = plan.dependencies.length > 0
      ? `\n## Dependencies\n\`\`\`\n${plan.dependencies.join('\n')}\n\`\`\``
      : '';

    return `# Project Plan

## Overview
${plan.description}

**Type:** ${plan.projectType}

## Files to Generate
${fileList}
${deps}

---
*Generated by Buildable Plan Mode*
`;
  }

  private formatArchitectureDoc(plan: ProjectPlan): string {
    // Build a Mermaid file dependency graph
    const graphLines: string[] = [];
    for (const f of plan.files) {
      for (const dep of f.dependencies) {
        const src = f.path.replace(/[./]/g, '_');
        const dst = dep.replace(/[./]/g, '_');
        graphLines.push(`  ${src} --> ${dst}`);
      }
    }

    const mermaidGraph = graphLines.length > 0
      ? `## File Dependency Graph\n\`\`\`mermaid\ngraph TD\n${graphLines.join('\n')}\n\`\`\``
      : '';

    // Bot command flow diagram
    const commands = (plan as ProjectPlan & { commands?: Array<{ name: string; description: string }> }).commands ?? [];
    const commandFlow = commands.length > 0
      ? `## Command Flow\n\`\`\`mermaid\nflowchart LR\n  User -->|sends command| Bot\n${commands.map(c => `  Bot -->|/${c.name}| Handler_${c.name.replace(/-/g, '_')}`).join('\n')}\n\`\`\``
      : '';

    return `# Architecture

## Overview
${plan.description}

**Project Type:** ${plan.projectType}

## Component Structure
\`\`\`
${plan.files.map(f => `${f.path.padEnd(30)} ${f.purpose}`).join('\n')}
\`\`\`

${mermaidGraph}

${commandFlow}

## Dependencies
\`\`\`
${plan.dependencies.join('\n')}
\`\`\`

---
*Generated by Buildable Architect Mode*
`;
  }

  private async applyTemplate(templateName: string): Promise<void> {
    logger.info({ templateName, sessionId: this.sessionId }, 'Applying template');
  }
}
