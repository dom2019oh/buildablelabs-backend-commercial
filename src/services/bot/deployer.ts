// =============================================================================
// Bot Deployer — manages Discord bot containers on Hetzner VPS
// Each bot is a Docker container running python main.py
// Files live at /bots/{workspaceId}/ on the host, mounted as /app in container
// =============================================================================

import admin from 'firebase-admin';
import { sshExec, sftpUploadFiles } from './ssh';
import { logger } from '../../utils/logger';

const BOTS_DIR       = process.env.BOT_BOTS_DIR    ?? '/bots';
const BASE_IMAGE     = process.env.BOT_BASE_IMAGE   ?? 'buildablelabs/discord-bot:latest';
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
  return Object.entries(data)
    .filter(([k]) => k !== 'updated_at')
    .map(([k, v]) => `${k}=${String(v)}`);
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

    // 4. Build env flags string
    const envFlags = envVars.map(e => {
      const [k, ...rest] = e.split('=');
      const v = rest.join('=').replace(/'/g, "'\\''"); // escape single quotes
      return `-e '${k}=${v}'`;
    }).join(' ');

    // 5. Run the container
    const runCmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--restart unless-stopped`,
      `-m ${CONTAINER_MEM} --cpus ${CONTAINER_CPU}`,
      `-v ${botDir}:/app`,
      envFlags,
      BASE_IMAGE,
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
