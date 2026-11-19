import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoUrl } from '../validate.js';

const ORIGIN = 'https://badger.example';
process.env.ALLOWED_ORIGINS = ORIGIN;
// These tests use the in-memory store and queue, whatever the shell has set.
// (With TABLE_NAME/QUEUE_URL exported for the integration test, server.js
// would otherwise pick DynamoDB/SQS.) node --test runs each file in its own
// process, so this doesn't affect test/aws-integration.test.js.
delete process.env.TABLE_NAME;
delete process.env.QUEUE_URL;
const { default: app, store, queue } = await import('../server.js');

let server, base;
before(() => new Promise((resolve) => {
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
after(() => new Promise((resolve) => server.close(resolve)));

const submit = (repoUrl, headers = {}) => fetch(`${base}/scan/repo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ repoUrl }),
});
const badgeValue = async (path) => {
  const svg = await (await fetch(`${base}/badge/${path}`)).text();
  return svg.match(/text-anchor="middle">([^<]+)</)[1];
};
const tick = () => new Promise((r) => setTimeout(r, 2)); // distinct scanId timestamps

// --- URL validation (docs/contracts.md "URL validation") ---

test('accepts GitHub repo URLs and normalizes them', () => {
  for (const [input, repo] of [
    ['https://github.com/Owner/Repo', 'owner/repo'],
    ['https://github.com/owner/repo/', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['  https://github.com/owner/my.repo_1-x  ', 'owner/my.repo_1-x'],
  ]) {
    const r = normalizeRepoUrl(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.repo, repo);
    assert.equal(r.url, `https://github.com/${repo}`);
  }
});

test('rejects everything the contract excludes', () => {
  for (const input of [
    undefined, '', 'not a url', 'github.com/owner/repo', 'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo', 'https://www.github.com/owner/repo',
    'https://github.com/owner', 'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo?x=1', 'https://github.com/owner/repo#readme',
    'https://user:pw@github.com/owner/repo', 'https://github.com:8443/owner/repo',
    'https://github.com/owner/re$po', 'https://github.com/owner/repo;rm',
  ]) {
    assert.equal(normalizeRepoUrl(input).ok, false, String(input));
  }
});

// --- POST /scan/repo ---

test('POST /scan/repo writes a queued record and sends the job message', async () => {
  const before = queue.messages.length;
  const res = await submit('https://github.com/Owner/Submit.git');
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.repo, 'owner/submit');
  assert.equal(body.status, 'queued');
  assert.match(body.scanId, /^\d{4}-\d\d-\d\dT[\d:.]+Z_[0-9a-f]{6}$/);

  assert.equal(queue.messages.length, before + 1);
  assert.deepEqual(queue.messages.at(-1), {
    version: 1, scanId: body.scanId, repo: 'owner/submit',
    repoUrl: 'https://github.com/owner/submit', requestedAt: body.requestedAt,
  });
  assert.equal((await store.getLatest('owner/submit')).scanId, body.scanId);
});

test('POST /scan/repo rejects invalid URLs with 400 and queues nothing', async () => {
  const before = queue.messages.length;
  const res = await submit('https://gitlab.com/a/b');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
  assert.equal(queue.messages.length, before);
});

// --- GET /grade ---

test('GET /grade returns 404 for a repo never scanned', async () => {
  assert.equal((await fetch(`${base}/grade/nobody/nothing`)).status, 404);
});

test('GET /grade returns the newest record of any status, case-insensitively', async () => {
  const first = await (await submit('https://github.com/o/grade')).json();
  await store.updateScan('o/grade', first.scanId, { status: 'complete', grade: 'B', score: 85 });
  await tick();
  const second = await (await submit('https://github.com/o/grade')).json();
  const latest = await (await fetch(`${base}/grade/O/Grade`)).json();
  assert.equal(latest.scanId, second.scanId);
  assert.equal(latest.status, 'queued');
});

test('GET /grade/:owner/:repo/history lists scans newest first', async () => {
  const a = await (await submit('https://github.com/o/hist')).json();
  await tick();
  const b = await (await submit('https://github.com/o/hist')).json();
  const body = await (await fetch(`${base}/grade/o/hist/history`)).json();
  assert.equal(body.repo, 'o/hist');
  assert.deepEqual(body.scans.map((s) => s.scanId), [b.scanId, a.scanId]);

  const empty = await (await fetch(`${base}/grade/o/never/history`)).json();
  assert.deepEqual(empty, { repo: 'o/never', scans: [] });
});

// --- GET /badge (precedence table in docs/contracts.md) ---

test('badge headers match the contract', async () => {
  const res = await fetch(`${base}/badge/o/headers`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(res.headers.get('cache-control'), 'max-age=300');
});

test('badge: unknown when never scanned or only failed scans', async () => {
  assert.equal(await badgeValue('o/badge-none'), 'unknown');
  const s = await (await submit('https://github.com/o/badge-failed')).json();
  await store.updateScan('o/badge-failed', s.scanId, { status: 'failed', error: 'clone failed' });
  assert.equal(await badgeValue('o/badge-failed'), 'unknown');
});

test('badge: scanning while the only scan is queued or running', async () => {
  const s = await (await submit('https://github.com/o/badge-run')).json();
  assert.equal(await badgeValue('o/badge-run'), 'scanning');
  await store.updateScan('o/badge-run', s.scanId, { status: 'running' });
  assert.equal(await badgeValue('o/badge-run'), 'scanning');
});

test('badge: a rescan in progress does not hide the last grade', async () => {
  const s = await (await submit('https://github.com/o/badge-rescan')).json();
  await store.updateScan('o/badge-rescan', s.scanId, { status: 'complete', grade: 'A', score: 95 });
  await tick();
  await submit('https://github.com/o/badge-rescan');
  assert.equal(await badgeValue('O/Badge-Rescan'), 'A');
});

test('badge: N/A when the newest complete scan found no JS/TS files', async () => {
  const s = await (await submit('https://github.com/o/badge-na')).json();
  await store.updateScan('o/badge-na', s.scanId, { status: 'complete', grade: 'N/A', score: null });
  assert.equal(await badgeValue('o/badge-na'), 'N/A');
});

// --- CORS (tests the real server.js wiring, where the original bug was) ---

test('CORS: allowed origin gets its origin back on the API', async () => {
  const res = await submit('https://github.com/o/cors-ok', { origin: ORIGIN });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const grade = await fetch(`${base}/grade/o/cors-ok`, { headers: { origin: ORIGIN } });
  assert.equal(grade.headers.get('access-control-allow-origin'), ORIGIN);
});

test('CORS: other origins get no allow header, including on preflight', async () => {
  const evil = 'https://evil.example';
  const res = await submit('https://github.com/o/cors-bad', { origin: evil });
  assert.equal(res.headers.get('access-control-allow-origin'), null);

  const pre = await fetch(`${base}/scan/repo`, {
    method: 'OPTIONS',
    headers: { origin: evil, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);

  const okPre = await fetch(`${base}/scan/repo`, {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(okPre.headers.get('access-control-allow-origin'), ORIGIN);
});

test('POST /scan/repo returns 503 and marks the record failed if the queue is down', async () => {
  const send = queue.send;
  queue.send = async () => { throw new Error('SQS unavailable'); };
  const original = console.error; console.error = () => {};
  try {
    const res = await submit('https://github.com/o/queue-down');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /Could not queue/);
    const rec = await store.getLatest('o/queue-down');
    assert.equal(rec.status, 'failed');
    assert.ok(rec.completedAt && rec.error);
  } finally {
    queue.send = send; console.error = original;
  }
});

test('existing SAST routes and /health still respond', async () => {
  assert.equal((await (await fetch(`${base}/health`)).json()).status, 'healthy');
  const scan = await fetch(`${base}/scan/code`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'eval(x)' }),
  });
  assert.equal(scan.status, 200);
});
