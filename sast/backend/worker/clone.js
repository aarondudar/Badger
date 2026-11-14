
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);

const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS ?? 120000);
const MAX_REPO_MB = Number(process.env.MAX_REPO_MB ?? 100);

/**
 * Calculates the total size of a directory in bytes.
 */
const getDirectorySize = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let totalSize = 0;

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(entryPath);
    } else if (entry.isFile()) {
      const stats = await fs.stat(entryPath);
      totalSize += stats.size;
    }
  }

  return totalSize;
};

/**
 * Safely shallow-clones a public GitHub repository.
 *
 * Returns the temporary directory, commit SHA, and a cleanup function.
 * The caller is responsible for calling cleanup when finished.
 */
export const cloneRepo = async (repoUrl) => {
  let parsedUrl;

  try {
    parsedUrl = new URL(repoUrl);
  } catch {
    throw new Error('Invalid repository URL');
  }

  const repoPath = parsedUrl.pathname.replace(/\.git$/, '');

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'github.com' ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !/^\/[^/]+\/[^/]+\/?$/.test(repoPath)
  ) {
    throw new Error('Only valid public HTTPS GitHub repository URLs are supported');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'badger-scan-'));
  const repoDir = path.join(tempRoot, 'repository');

  try {
    await execFile(
      'git',
      ['clone', '--depth', '1', '--', repoUrl, repoDir],
      {
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }
    );

    const sizeBytes = await getDirectorySize(repoDir);
    const maxBytes = MAX_REPO_MB * 1024 * 1024;

    if (sizeBytes > maxBytes) {
      throw new Error(`Repository exceeds the ${MAX_REPO_MB} MB size limit`);
    }

    const { stdout } = await execFile(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repoDir, timeout: 10000 }
    );

    const commitSha = stdout.trim();

    return {
      repoDir,
      commitSha,
      cleanup: () =>
        fs.rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });

    if (error.killed) {
      throw new Error('Repository clone timed out');
    }

    throw error;
  }
};
