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
import { env } from '../../config/env';

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
  private options: PipelineOptions['options'];

  constructor(config: PipelineOptions) {
    this.workspaceId = config.workspaceId;
    this.userId = config.userId;
    this.sessionId = config.sessionId;
    this.prompt = config.prompt;
    this.mode = config.mode ?? 'build';
    this.options = config.options;
  }

  async run(): Promise<void> {
    const startTime = Date.now();

    try {
      if (this.mode === 'plan') {
        await this.runPlanMode(startTime);
      } else if (this.mode === 'architect') {
        await this.runArchitectMode(startTime);
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

    const architect = new Architect(env.DEFAULT_ARCHITECT_MODEL);
    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    const plan = await architect.createPlan(this.prompt, existingFiles);

    await db.updateSession(this.sessionId, {
      plan: plan as unknown as object,
      files_planned: plan.files.length,
    });

    // Write a human-readable PLAN.md so it appears in the file explorer
    const planContent = this.formatPlanAsMarkdown(plan);
    await db.upsertFile(this.workspaceId, this.userId, 'PLAN.md', planContent);

    const duration = Date.now() - startTime;

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: 1,
      completed_at: new Date().toISOString(),
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({ sessionId: this.sessionId, durationMs: duration }, '[Plan Mode] Plan created');
  }

  // ===========================================================================
  // ARCHITECT MODE — Plan + architecture docs + Mermaid diagrams
  // ===========================================================================

  private async runArchitectMode(startTime: number): Promise<void> {
    logger.info({ sessionId: this.sessionId }, '[Architect Mode] Starting architecture phase');

    await db.updateSession(this.sessionId, { status: 'planning' });

    const architect = new Architect(env.DEFAULT_ARCHITECT_MODEL);
    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    const plan = await architect.createPlan(this.prompt, existingFiles);

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

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: 2,
      completed_at: new Date().toISOString(),
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({ sessionId: this.sessionId, durationMs: duration }, '[Architect Mode] Architecture docs created');
  }

  // ===========================================================================
  // BUILD MODE — Full pipeline: plan → scaffold → generate → validate
  // ===========================================================================

  private async runBuildMode(startTime: number): Promise<void> {
    // PHASE 1: ARCHITECT
    logger.info({ sessionId: this.sessionId }, 'Phase 1: Architect - Planning');

    await db.updateSession(this.sessionId, { status: 'planning' });

    const architect = new Architect(env.DEFAULT_ARCHITECT_MODEL);
    const existingFiles = await db.getWorkspaceFiles(this.workspaceId);

    const plan = await architect.createPlan(this.prompt, existingFiles);

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

    const coder = new Coder(env.DEFAULT_CODER_MODEL);
    let filesGenerated = 0;

    for (const fileSpec of plan.files) {
      try {
        const currentFiles = await db.getWorkspaceFiles(this.workspaceId);

        const content = await coder.generateFile(
          fileSpec,
          plan,
          currentFiles,
          this.prompt
        );

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
            aiModel: env.DEFAULT_CODER_MODEL,
            aiReasoning: fileSpec.purpose,
          }
        );

        await db.upsertFile(
          this.workspaceId,
          this.userId,
          fileSpec.path,
          content
        );

        filesGenerated++;

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

    // PHASE 4: VALIDATION
    logger.info({ sessionId: this.sessionId }, 'Phase 4: Validating');

    await db.updateSession(this.sessionId, { status: 'validating' });

    const validator = new Validator();
    const allFiles = await db.getWorkspaceFiles(this.workspaceId);

    const validationResult = await validator.validate(allFiles);

    if (validationResult.errors.length > 0) {
      logger.warn({
        sessionId: this.sessionId,
        errors: validationResult.errors,
      }, 'Validation found issues, attempting auto-repair');

      for (const repair of validationResult.repairs) {
        await db.upsertFile(
          this.workspaceId,
          this.userId,
          repair.filePath,
          repair.content
        );
      }
    }

    const duration = Date.now() - startTime;

    await db.updateSession(this.sessionId, {
      status: 'completed',
      files_generated: filesGenerated,
      completed_at: new Date().toISOString(),
    });

    await db.updateWorkspaceStatus(this.workspaceId, 'ready');

    logger.info({
      sessionId: this.sessionId,
      filesGenerated,
      durationMs: duration,
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
