import crypto from 'node:crypto';

export const createMemoryStore = () => {
  const scans = new Map();
  // scanIds start with an ISO timestamp, so string order is time order.
  const newestFirst = (repo) => [...scans.values()]
    .filter((scan) => scan.repo === repo)
    .sort((a, b) => b.scanId.localeCompare(a.scanId));

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
    // Newest record of any status (GET /grade).
    async getLatest(repo) {
      return newestFirst(repo)[0] ?? null;
    },
    // Newest COMPLETE record (badge), so a rescan in progress doesn't hide the last grade.
    async getLatestComplete(repo) {
      return newestFirst(repo).find((scan) => scan.status === 'complete') ?? null;
    },
    // What the worker does as a scan moves through running -> complete | failed.
    async updateScan(repo, scanId, fields) {
      const scan = scans.get(`${repo}:${scanId}`);
      if (!scan) return null;
      Object.assign(scan, fields);
      return scan;
    },
    async getHistory(repo) {
      return newestFirst(repo).slice(0, 20);
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
