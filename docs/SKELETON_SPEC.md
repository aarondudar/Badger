# Project Skeleton Spec: GitHub Repo Report Card

Implementation spec for Claude Code. Scope is **Milestone 1 (skeleton) and Milestone 2 (local end-to-end)** only. No AWS deployment yet.

## 1. Context

This is a team semester project for CS6620 Cloud Computing. The course provides two Node/Express tools in this repo:

- `sast/backend/`: a regex-based SAST scanner for JavaScript (endpoints like `POST /scan/code`, `POST /scan/directory`)
- `pentest/backend/`: an API penetration tester (not used in this phase)

**Product:** A user submits a public GitHub repo URL. The system clones it, runs the SAST scanner on its JavaScript files, computes a security grade, stores the result, and serves an embeddable README badge showing the latest grade.

**Course rules that constrain the code:**

- The provided Express backend must be **extended, not replaced**. Keep all existing SAST routes working.
- At least one component must be Dockerized.
- No hardcoded secrets anywhere. Config comes from environment variables.
- Final deployment will be AWS (ECS Fargate, SQS, DynamoDB, S3), but this phase runs entirely locally against emulated AWS services.

## 2. Phase 0: Inspect before writing code

Before creating anything, read `sast/backend/` and report back:

1. How scanning is implemented: is there an importable function, or is the logic inside route handlers?
2. The exact shape of a scan report (field names, severity values, line numbers).
3. Which file extensions the directory scan includes, and whether it skips `node_modules`.
4. The regex patterns for hardcoded secrets (needed for the fixtures in section 7).
5. Node version and dependencies in `package.json`.

If the scanner logic isn't importable, do the **minimal** refactor: extract it into an exported function (e.g. `scanDirectory(path)`) that the existing routes call, so their behavior is unchanged. Update `docs/contracts.md` wherever the real report shape differs from this spec, and note each deviation.

## 3. Repository layout

Keep the provided code where it is. Add new code around it.

```
sast/backend/            ← provided; extended (API + worker share this codebase and image)
  src/ (or existing structure)
    routes/repo.js         new routes (section 5)
    worker/index.js        queue consumer entrypoint
    worker/clone.js        safe shallow clone
    worker/pipeline.js     clone → scan → grade → store
    grading/grade.js       pure grading functions
    aws/clients.js         shared AWS SDK v3 client factory
    badge/svg.js           badge SVG generation
  test/
  Dockerfile               one image, two entrypoints
pentest/                 ← provided; do not modify
frontend/                ← minimal static page (section 8)
fixtures/                ← test repos with known expected results (section 7)
infra/
  localstack/init.sh       creates queue, table, bucket on LocalStack startup
  README.md                placeholder: "AWS deployment scripts go here (Milestone 3)"
docs/
  contracts.md
  architecture.md          stub with a Mermaid diagram of the target AWS architecture
  decisions/
    0000-template.md
    0001-localstack-for-local-dev.md
    0002-single-image-api-and-worker.md
.github/
  workflows/ci.yml
  pull_request_template.md
docker-compose.yml
.env.example
README.md                ← setup instructions (section 10)
```

## 4. Configuration

Read all config from environment variables, with `.env.example` documenting every one. Never commit `.env`.

| Variable | Example (local) | Purpose |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Learner Lab region |
| `AWS_ENDPOINT_URL` | `http://localstack:4566` | Set locally only; unset on real AWS |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | Dummy values for LocalStack only |
| `QUEUE_URL` | `http://localstack:4566/000000000000/scan-jobs` | SQS job queue |
| `TABLE_NAME` | `scans` | DynamoDB table |
| `BUCKET_NAME` | `scan-reports` | S3 bucket for full reports |
| `PORT` | `3000` | API port |
| `CLONE_TIMEOUT_MS` | `60000` | Abort slow clones |
| `MAX_REPO_MB` | `100` | Reject oversized repos |

`aws/clients.js` creates the SQS, DynamoDB, and S3 clients once, passing `endpoint` explicitly when `AWS_ENDPOINT_URL` is set (and `forcePathStyle: true` for S3). No other file constructs AWS clients.

## 5. Contracts

Write these into `docs/contracts.md`. They let teammates build the API, worker, and frontend in parallel.

### API routes (new, added to the existing Express app)

**`POST /scan/repo`**
Request: `{ "repoUrl": "https://github.com/owner/name" }`
Response `202`: `{ "scanId": "...", "repo": "owner/name", "status": "queued" }`
Response `400`: invalid URL (see validation below)

**`GET /grade/:owner/:repo`**
Response `200`: the latest scan record (section 5, "Scan record")
Response `404`: never scanned

**`GET /grade/:owner/:repo/history`**
Response `200`: up to 20 most recent scan records, newest first

**`GET /badge/:owner/:repo`**
Response `200`: SVG image, `Content-Type: image/svg+xml`, `Cache-Control: max-age=300`
Shows the latest completed grade, "scanning", "N/A", or "unknown"

**URL validation:** accept only `^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$` (optionally ending `.git`). Normalize `owner/name` to lowercase for storage keys. Reject everything else, including other hosts, paths beyond the repo, and query strings.

### Job message (SQS body, JSON)

```json
{
  "version": 1,
  "scanId": "2026-10-21T18:04:11.532Z_a1b2c3",
  "repo": "owner/name",
  "repoUrl": "https://github.com/owner/name",
  "requestedAt": "2026-10-21T18:04:11.532Z"
}
```

`scanId` is an ISO timestamp plus a short random suffix, so it sorts chronologically.

### Scan record (DynamoDB item)

Table `scans`: partition key `repo` (string, `owner/name` lowercase), sort key `scanId` (string). Latest scan = query by `repo`, `ScanIndexForward: false`, `Limit: 1`.

```json
{
  "repo": "owner/name",
  "scanId": "2026-10-21T18:04:11.532Z_a1b2c3",
  "status": "queued | running | complete | failed",
  "requestedAt": "...",
  "completedAt": "...",
  "commitSha": "...",
  "jsFilesScanned": 42,
  "counts": { "critical": 0, "high": 2, "medium": 5, "low": 1 },
  "score": 71,
  "grade": "C",
  "reportKey": "reports/owner/name/<scanId>.json",
  "error": "only present when status is failed"
}
```

Severity keys must match the scanner's actual severity values (confirm in Phase 0).

### Full report (S3 object)

`s3://<BUCKET_NAME>/reports/<owner>/<name>/<scanId>.json` holds the scanner's complete findings plus the summary fields above. DynamoDB holds only the summary, so the table stays small and fast.

## 6. Worker pipeline

`worker/index.js` long-polls SQS (`WaitTimeSeconds: 20`), processes one message at a time, and deletes the message only after the record is written as `complete` or `failed`.

For each job:

1. Write the record with `status: running`.
2. **Clone safely** (`worker/clone.js`):
   - Use `child_process.execFile("git", ["clone", "--depth", "1", "--", url, dir])`. **Never** use `exec` or a shell string; repo URLs are user input.
   - Clone into a fresh temp directory; always delete it in a `finally` block.
   - Enforce `CLONE_TIMEOUT_MS` and `MAX_REPO_MB`.
   - Record the commit SHA (`git rev-parse HEAD`).
3. Run the provided scanner on the clone's JavaScript files, excluding `node_modules`, `.git`, and minified bundles (`*.min.js`).
4. Grade the results (below).
5. Upload the full report to S3, then write the summary record as `complete`.
6. On any error, write `status: failed` with a short, user-safe error message (no stack traces in the record; log those).

### Grading (`grading/grade.js`)

Pure functions only, no I/O, fully unit-tested.

- `score = max(0, 100 − Σ(count × weight))`, with weights in one exported constant, starting at `critical 25, high 10, medium 4, low 1`.
- Letter grade: `A ≥ 90`, `B ≥ 80`, `C ≥ 70`, `D ≥ 60`, else `F`.
- If `jsFilesScanned === 0`, return grade `"N/A"` and `score: null`. Never award an A for scanning nothing.

## 7. Fixtures and tests

Create three fixture directories with expected results in `fixtures/expected.json`:

- `fixtures/vulnerable-js/`: a few small files containing hardcoded secrets, `eval`, string-built SQL, `Math.random()` for tokens, MD5 hashing. Expected: grade D or F, with specific counts.
- `fixtures/clean-js/`: comparable code with none of those issues. Expected: grade A.
- `fixtures/no-js/`: a couple of Python and Markdown files. Expected: `N/A`, `jsFilesScanned: 0`.

**Fake secrets must be obviously fake** (e.g. `const password = "FAKE_PASSWORD_FOR_TESTS"`) but still match the scanner's patterns. Do not use strings shaped like real cloud provider keys, or GitHub's push protection may block the push.

Tests:

- **Unit:** grading thresholds, N/A case, URL validation (valid URLs, other hosts, extra path segments, query strings, shell metacharacters), badge SVG output.
- **Fixture tests:** run the scan step (skipping clone) against each fixture and compare with `expected.json`.
- **Regression:** existing provided routes (`POST /scan/code`, `GET /health`, etc.) still respond as before.

Use whatever test runner the provided backend already uses; if none, use Node's built-in `node:test`.

## 8. Frontend (minimal placeholder)

`frontend/index.html` with inline JS, no framework or build step. The team will choose a framework later; record that as an open decision.

- A form to submit a repo URL, which calls `POST /scan/repo`.
- Poll `GET /grade/:owner/:repo` every 3 seconds until `complete` or `failed`.
- Show the grade, score, counts, and JS files scanned.
- Show the badge image and a copyable Markdown snippet: `![Security grade](<API_BASE>/badge/owner/name)`.
- Serve it from the API container's static middleware for now (its S3 + CloudFront hosting comes in Milestone 4). Enable CORS on the API for a configurable origin.

## 9. Local environment

`docker-compose.yml` runs three services:

- `localstack`: pinned image version, services `sqs,dynamodb,s3`, mounting `infra/localstack/init.sh` into `/etc/localstack/init/ready.d/` to create the queue, table, and bucket. **Check LocalStack's current free-tier terms before pinning.** If the free image now requires an account or auth token, tell me rather than silently adding one, and propose the fallback (ElasticMQ for SQS, DynamoDB Local, MinIO for S3).
- `api`: built from `sast/backend/Dockerfile`, runs the Express app, depends on LocalStack being healthy.
- `worker`: same image, different command (e.g. `npm run worker`), needs `git` installed in the image.

The Dockerfile: current Node LTS slim base (or match `engines` in `package.json`), install `git`, `npm ci --omit=dev`, run as a non-root user, no secrets baked in.

## 10. CI and repo hygiene

`.github/workflows/ci.yml`, on every PR and push to `main`:

1. `npm ci` and run all tests in `sast/backend`.
2. `docker build` the image.
3. Pin action versions to exact tags.

Deployment is **not** automated: Learner Lab credentials rotate each session, so deploys will be a manual script added in Milestone 3.

Also add:

- `.gitignore` covering `.env`, `node_modules`, temp clone dirs, and LocalStack data.
- `.github/pull_request_template.md`: what changed, how it was tested, whether `docs/contracts.md` changed.
- `docs/decisions/0000-template.md` with sections: Context, Options considered, Decision, Consequences. Fill in 0001 and 0002 from this spec's reasoning.
- `README.md`: prerequisites (Docker, Node, git), `cp .env.example .env`, `docker compose up`, a curl example for each new route, how to run tests, and a link to `docs/contracts.md`.

## 11. Out of scope for this task

- Any real AWS resources, CloudFormation, or deploy scripts
- Authentication or user accounts
- Scanning private repos or using a GitHub token
- Deduplicating concurrent scans of the same repo
- The pentest tool
- Choosing a frontend framework

## 12. Acceptance criteria

- [ ] Phase 0 findings reported, and `docs/contracts.md` matches the real scanner output
- [ ] `docker compose up` starts LocalStack, API, and worker with no manual steps
- [ ] `POST /scan/repo` with a small public JavaScript repo returns `202`, and `GET /grade/...` reaches `complete` with a grade
- [ ] The full report exists in the LocalStack S3 bucket at the documented key
- [ ] `GET /badge/...` returns a valid SVG showing that grade
- [ ] An invalid URL returns `400` and never reaches the queue
- [ ] All unit, fixture, and regression tests pass locally and in CI
- [ ] Existing provided SAST routes still work unchanged
- [ ] `pentest/` is untouched
- [ ] No secrets, real or dummy, appear anywhere except `.env.example`'s LocalStack `test` placeholders

Work in small, focused commits (one concern each) so teammates can review the history.
