// =============================================================================
// SSH Client — wraps ssh2 for VPS communication
// All bot hosting is SSH-driven: file upload via SFTP, commands via exec.
// =============================================================================

import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { logger } from '../../utils/logger';

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string; // PEM string (not base64)
}

function getSSHConfig(): SSHConfig {
  const keyB64 = process.env.BOT_SSH_KEY ?? '';
  const privateKey = keyB64
    ? Buffer.from(keyB64, 'base64').toString('utf8')
    : '';

  return {
    host:       process.env.BOT_HOST     ?? '',
    port:       Number(process.env.BOT_SSH_PORT ?? 22),
    username:   process.env.BOT_SSH_USER ?? 'root',
    privateKey,
  };
}

// ─── Run a single command over SSH ──────────────────────────────────────────

export function sshExec(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cfg = getSSHConfig();
    if (!cfg.host || !cfg.privateKey) {
      return reject(new Error('BOT_HOST / BOT_SSH_KEY env vars not configured.'));
    }

    const conn = new Client();
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }

        stream
          .on('close', (code: number) => {
            conn.end();
            if (code !== 0) {
              reject(new Error(`SSH command exited ${code}: ${stderr.trim()}`));
            } else {
              resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
            }
          })
          .on('data', (d: Buffer) => { stdout += d.toString(); })
          .stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      });
    })
    .on('error', reject)
    .connect(cfg as ConnectConfig);
  });
}

// ─── Upload files via SFTP ───────────────────────────────────────────────────

export function sftpUploadFiles(
  files: Array<{ path: string; content: string }>,
  remoteDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cfg = getSSHConfig();
    if (!cfg.host || !cfg.privateKey) {
      return reject(new Error('BOT_HOST / BOT_SSH_KEY env vars not configured.'));
    }

    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp: SFTPWrapper) => {
        if (err) { conn.end(); return reject(err); }

        const uploadNext = (idx: number) => {
          if (idx >= files.length) {
            sftp.end();
            conn.end();
            return resolve();
          }

          const file = files[idx];
          const remotePath = `${remoteDir}/${file.path}`;
          const remoteFileDir = remotePath.substring(0, remotePath.lastIndexOf('/'));

          // mkdir -p for the file's parent directory, then write
          sftp.mkdir(remoteFileDir, { mode: 0o755 }, () => {
            // Ignore mkdir error (dir may already exist)
            const writeStream = sftp.createWriteStream(remotePath, { mode: 0o644 });
            writeStream.on('close', () => uploadNext(idx + 1));
            writeStream.on('error', reject);
            writeStream.end(Buffer.from(file.content, 'utf8'));
          });
        };

        uploadNext(0);
      });
    })
    .on('error', reject)
    .connect(cfg as ConnectConfig);
  });
}
