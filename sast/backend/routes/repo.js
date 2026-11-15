import express from 'express';
import cors from 'cors';
import { normalizeRepoUrl } from '../validate.js';
import { renderBadge } from '../badge/render.js';

export const createRepoRouter = ({ store, queue, allowedOrigins = [] }) => {
  const router = express.Router();
  const corsOrigin = (requestOrigin, callback) => {
    if (!requestOrigin || allowedOrigins.includes(requestOrigin)) return callback(null, true);
    return callback(null, false);
  };
  const apiCors = cors({ origin: corsOrigin, methods: ['GET', 'POST'] });

  // Browser preflight for the JSON POST must be answered by the allow-list too.
  router.options('/scan/repo', apiCors);

  router.post('/scan/repo', apiCors, async (req, res, next) => {
    try {
      const repo = normalizeRepoUrl(req.body?.repoUrl);
      if (!repo.ok) return res.status(400).json({ error: repo.error });
      const scan = await store.createScan(repo.repo);
      await queue.send({
        version: 1,
        scanId: scan.scanId,
        repo: scan.repo,
        repoUrl: repo.url,
        requestedAt: scan.requestedAt,
      });
      return res.status(202).json(scan);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/grade/:owner/:repo', apiCors, async (req, res, next) => {
    try {
      const scan = await store.getLatest(`${req.params.owner}/${req.params.repo}`.toLowerCase());
      return scan ? res.json(scan) : res.status(404).json({ error: 'scan not found' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/grade/:owner/:repo/history', apiCors, async (req, res, next) => {
    try {
      const repo = `${req.params.owner}/${req.params.repo}`.toLowerCase();
      return res.json({ repo, scans: await store.getHistory(repo) });
    } catch (error) {
      return next(error);
    }
  });

  // Badges are open on purpose: READMEs load them through GitHub's image proxy.
  router.get('/badge/:owner/:repo', async (req, res, next) => {
    try {
      // Precedence from docs/contracts.md: newest complete grade (or N/A),
      // else "scanning" while one is queued/running, else "unknown".
      const repo = `${req.params.owner}/${req.params.repo}`.toLowerCase();
      const complete = await store.getLatestComplete(repo);
      const latest = complete ? null : await store.getLatest(repo);
      const value = complete ? complete.grade :
        latest?.status === 'queued' || latest?.status === 'running' ? 'scanning' : 'unknown';
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'max-age=300');
      return res.send(renderBadge(value));
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
