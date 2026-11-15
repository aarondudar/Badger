import crypto from 'node:crypto';

export const createMemoryStore = () => {
  const scans = new Map();

  return {
    async createScan(repo) {
      const requestedAt = new Date().toISOString();
      const scan = {
        repo,
        scanId: `${requestedAt}_${crypto.randomBytes(3).toString('hex')}`,
        status: 'queued',
        requestedAt,
      };
      scans.set(`${repo}:${scan.scanId}`, scan);
      return scan;
    },
    async getLatest(repo) {
      return [...scans.values()]
        .filter((scan) => scan.repo === repo)
        .sort((a, b) => b.scanId.localeCompare(a.scanId))[0] ?? null;
    },
    async getHistory(repo) {
      return [...scans.values()]
        .filter((scan) => scan.repo === repo)
        .sort((a, b) => b.scanId.localeCompare(a.scanId))
        .slice(0, 20);
    },
  };
};

export const createMemoryQueue = () => {
  const messages = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
  };
};
