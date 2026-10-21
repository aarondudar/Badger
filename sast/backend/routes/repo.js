import express from 'express';

// Routes for repo scanning, grades, and badges (see docs/contracts.md)
const router = express.Router();

// POST /scan/repo
// GET  /grade/:owner/:repo
// GET  /grade/:owner/:repo/history
// GET  /badge/:owner/:repo

export default router;
