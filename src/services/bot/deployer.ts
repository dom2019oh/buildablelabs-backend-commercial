// =============================================================================
// Bot Deployer — manages Discord bot containers on Hetzner VPS
// Each bot is a Docker container running python main.py
// Files live at /bots/{workspaceId}/ on the host, mounted as /app in container
// =============================================================================

import admin from 'firebase-admin';
import { sshExec, sftpUploadFiles } from './ssh';
import { logger } from '../../utils/logger';

const BOTS_DIR       = process.env.BOT_BOTS_DIR    ?? '/bots';
const BASE_IMAGE     = process.env.BOT_BASE_IMAGE   ?? 'python:3.11-slim';
const CONTAINER_MEM  = process.env.BOT_CONTAINER_MEM ?? '128m';
const CONTAINER_CPU  = process.env.BOT_CONTAINER_CPU ?? '0.15';

export type BotStatus = 'not_deployed' | 'deploying' | 'running' | 'stopped' | 'error';

export interface BotDeployment {
  workspaceId: string;
  status: BotStatus;
  containerId: string | null;
  error: string | null;
  deployedAt: string | null;
  stoppedAt: string | null;
  logs?: string;
}

// ─── Firestore helpers ───────────────────────────────────────────────────────

function deploymentRef(workspaceId: string) {
  return admin.firestore().collection('botDeployments').doc(workspaceId);
}

async function setStatus(
  workspaceId: string,
  status: BotStatus,
  extra: Partial<BotDeployment> = {},
) {
  await deploymentRef(workspaceId).set({
    workspaceId,
    status,
    containerId: null,
    error: null,
    deployedAt: null,
    stoppedAt: null,
    ...extra,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ─── Get workspace files from Firestore ──────────────────────────────────────

async function getWorkspaceFiles(workspaceId: string) {
  const snap = await admin.firestore()
    .collection('workspaceFiles')
    .where('workspace_id', '==', workspaceId)
    .get();

  return snap.docs.map(d => ({
    path: d.data().file_path as string,
    content: d.data().content as string,
  }));
}

// ─── Get env vars from Firestore projectEnvVars ──────────────────────────────

async function getBotEnvVars(workspaceId: string): Promise<string[]> {
  // Look up the project linked to this workspace
  const wsSnap = await admin.firestore().collection('workspaces').doc(workspaceId).get();
  if (!wsSnap.exists) return [];

  const projectId = wsSnap.data()?.project_id as string | undefined;
  if (!projectId) return [];

  const envSnap = await admin.firestore().collection('projectEnvVars').doc(projectId).get();
  if (!envSnap.exists) return [];

  const data = envSnap.data()!;
  const vars = Object.entries(data)
    .filter(([k]) => k !== 'updated_at')
    .map(([k, v]) => `${k}=${String(v)}`);

  // Backwards-compat alias: generated code may use DISCORD_TOKEN (older bots)
  // If only BOT_TOKEN is present, inject DISCORD_TOKEN pointing to the same value
  const hasBotToken      = vars.some(e => e.startsWith('BOT_TOKEN='));
  const hasDiscordToken  = vars.some(e => e.startsWith('DISCORD_TOKEN='));
  if (hasBotToken && !hasDiscordToken) {
    const val = vars.find(e => e.startsWith('BOT_TOKEN='))!.slice('BOT_TOKEN='.length);
    vars.push(`DISCORD_TOKEN=${val}`);
  }

  return vars;
}

// ─── Generate requirements.txt if not present ────────────────────────────────

function hasRequirements(files: Array<{ path: string }>) {
  return files.some(f => f.path === 'requirements.txt');
}

const DEFAULT_REQUIREMENTS = `discord.py>=2.3.0
aiohttp>=3.8.0
aiosqlite>=0.19.0
python-dotenv>=1.0.0
`;

// ─── DEPLOY ──────────────────────────────────────────────────────────────────

export async function deployBot(workspaceId: string): Promise<void> {
  logger.info({ workspaceId }, 'Deploying bot');
  await setStatus(workspaceId, 'deploying');

  try {
    const [files, envVars] = await Promise.all([
      getWorkspaceFiles(workspaceId),
      getBotEnvVars(workspaceId),
    ]);

    if (files.length === 0) {
      throw new Error('No files found for this workspace. Generate the bot first.');
    }

    // Inject default requirements.txt if missing
    if (!hasRequirements(files)) {
      files.push({ path: 'requirements.txt', content: DEFAULT_REQUIREMENTS });
    }

    const botDir = `${BOTS_DIR}/${workspaceId}`;
    const containerName = `bot-${workspaceId}`;

    // 1. Create directory on host
    await sshExec(`mkdir -p ${botDir}`);

    // 2. Upload all bot files via SFTP
    await sftpUploadFiles(files, botDir);

    // 3. Stop + remove any existing container with this name
    await sshExec(
      `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null; echo done`
    );

    // 4. Write env vars to a file on the VPS — never pass secrets as -e flags
    //    (command-line -e args are visible in `ps aux` and SSH logs)
    const envFileContent = envVars.join('\n');
    const envFilePath = `${botDir}/.env.deploy`;
    await sftpUploadFiles([{ path: '.env.deploy', content: envFileContent }], botDir);
    await sshExec(`chmod 600 ${envFilePath}`); // owner-read only

    // 5. Write a start.sh bootstrap script — avoids shell quoting issues in docker run
    //    This installs pip deps (using a shared cache for fast subsequent starts)
    //    then launches the bot.
    const startScript = `#!/bin/bash
set -e
pip install -r /app/requirements.txt -q --cache-dir /pip-cache
cd /app
exec python main.py
`;
    await sftpUploadFiles([{ path: 'start.sh', content: startScript }], botDir);
    await sshExec(`chmod +x ${botDir}/start.sh`);

    // 6. Ensure shared pip-cache directory exists on host
    await sshExec(`mkdir -p ${BOTS_DIR}/.pip-cache`);

    // 7. Run the container — secrets injected via --env-file, never in command line
    const runCmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--restart unless-stopped`,
      `-m ${CONTAINER_MEM} --cpus ${CONTAINER_CPU}`,
      `-v ${botDir}:/app`,
      `-v ${BOTS_DIR}/.pip-cache:/pip-cache`,
      `--env-file ${envFilePath}`,
      BASE_IMAGE,
      `/app/start.sh`,
    ].join(' ');

    const { stdout } = await sshExec(runCmd);
    const containerId = stdout.trim().slice(0, 12);

    await setStatus(workspaceId, 'running', {
      containerId,
      deployedAt: new Date().toISOString(),
      error: null,
    });

    logger.info({ workspaceId, containerId }, 'Bot deployed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ workspaceId, err: msg }, 'Bot deploy failed');
    await setStatus(workspaceId, 'error', { error: msg });
    throw err;
  }
}

// ─── STOP ────────────────────────────────────────────────────────────────────

export async function stopBot(workspaceId: string): Promise<void> {
  logger.info({ workspaceId }, 'Stopping bot');
  try {
    await sshExec(`docker stop bot-${workspaceId} 2>/dev/null; echo done`);
    await setStatus(workspaceId, 'stopped', { stoppedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setStatus(workspaceId, 'error', { error: msg });
    throw err;
  }
}

// ─── RESTART ─────────────────────────────────────────────────────────────────

export async function restartBot(workspaceId: string): Promise<void> {
  logger.info({ workspaceId }, 'Restarting bot');
  await setStatus(workspaceId, 'deploying');
  try {
    await sshExec(`docker restart bot-${workspaceId}`);
    await setStatus(workspaceId, 'running', { deployedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setStatus(workspaceId, 'error', { error: msg });
    throw err;
  }
}

// ─── STATUS ──────────────────────────────────────────────────────────────────

export async function getBotStatus(workspaceId: string): Promise<BotDeployment> {
  const snap = await deploymentRef(workspaceId).get();
  if (!snap.exists) {
    return { workspaceId, status: 'not_deployed', containerId: null, error: null, deployedAt: null, stoppedAt: null };
  }
  return snap.data() as BotDeployment;
}

// ─── LOGS ────────────────────────────────────────────────────────────────────

export async function getBotLogs(workspaceId: string, lines = 80): Promise<string> {
  try {
    const { stdout } = await sshExec(
      `docker logs --tail ${lines} bot-${workspaceId} 2>&1`
    );
    return stdout;
  } catch {
    return 'No logs available.';
  }
}
