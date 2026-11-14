# Contracts

API routes, SQS job message, DynamoDB scan record, and S3 report layout. These let the API, worker, and frontend be built in parallel. Based on `SKELETON_SPEC.md` section 5, adjusted to the real scanner output found in Phase 0 ([`phase0-findings.md`](phase0-findings.md)). Every difference from the spec is listed under [Deviations from the spec](#deviations-from-the-spec).

Change this file in the same PR as any code that changes a contract, and tick the box in the PR template.

## API routes

New routes, added to the existing Express app alongside the provided SAST routes (which are unchanged). Error responses use the body `{ "error": "<user-safe message>" }`.

### `POST /scan/repo`

Request:

```json
{ "repoUrl": "https://github.com/owner/name" }
```

- `202`: `{ "scanId": "2026-10-21T18:04:11.532Z_a1b2c3", "repo": "owner/name", "status": "queued" }`. The `queued` record is written and the job message sent before responding.
- `400`: `repoUrl` missing or invalid (see [URL validation](#url-validation)). Nothing is written or queued.

### `GET /grade/:owner/:repo`

- `200`: the latest [scan record](#scan-record-dynamodb), whatever its status.
- `404`: never scanned.

### `GET /grade/:owner/:repo/history`

- `200`: `{ "repo": "owner/name", "scans": [ ...scan records ] }`, with up to 20 records, newest first. An empty `scans` array means never scanned.

### `GET /badge/:owner/:repo`

- `200` always, `Content-Type: image/svg+xml`, `Cache-Control: max-age=300`.
- The value shown is chosen as follows:

| Situation | Badge value |
|---|---|
| A `complete` scan exists with a letter grade | Grade of the newest `complete` scan (`A`–`F`) |
| Newest `complete` scan found no JS/TS files | `N/A` |
| No `complete` scan, and the newest record is `queued` or `running` | `scanning` |
| Never scanned, or only `failed` scans | `unknown` |

`:owner` and `:repo` in all `GET` routes are matched case-insensitively (lowercased before lookup).

### URL validation

Accept only:

```
^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$
```

A trailing `.git` is also accepted and stripped. Reject everything else, including other hosts, `http://`, paths beyond the repo, query strings, fragments, and shell metacharacters. `repo` is `owner/name` lowercased; it is the storage key everywhere. `repoUrl` in the job message is rebuilt as `https://github.com/<repo>`, not the raw user input.

## Job message (SQS)

Queue: `QUEUE_URL`. Body is JSON:

```json
{
  "version": 1,
  "scanId": "2026-10-21T18:04:11.532Z_a1b2c3",
  "repo": "owner/name",
  "repoUrl": "https://github.com/owner/name",
  "requestedAt": "2026-10-21T18:04:11.532Z"
}
```

- `scanId` is the ISO timestamp of the request, `_`, and a 6-character lowercase hex suffix, so IDs sort chronologically.
- `version` is bumped on any breaking change to this message; the worker rejects versions it does not know (records `failed`).
- The worker deletes the message only after writing the record as `complete` or `failed`.

## Scan record (DynamoDB)

Table `TABLE_NAME` (`scans`): partition key `repo` (string), sort key `scanId` (string). Latest scan: query by `repo` with `ScanIndexForward: false`, `Limit: 1`.

```json
{
  "repo": "owner/name",
  "scanId": "2026-10-21T18:04:11.532Z_a1b2c3",
  "status": "complete",
  "requestedAt": "2026-10-21T18:04:11.532Z",
  "completedAt": "2026-10-21T18:04:20.101Z",
  "commitSha": "3f2c9e1b7a...",
  "jsFilesScanned": 42,
  "counts": { "high": 2, "medium": 5, "low": 1 },
  "score": 71,
  "grade": "C",
  "reportKey": "reports/owner/name/2026-10-21T18:04:11.532Z_a1b2c3.json"
}
```

| Field | Type | Present when |
|---|---|---|
| `repo`, `scanId`, `status`, `requestedAt` | string | always |
| `status` | `queued` \| `running` \| `complete` \| `failed` | always |
| `completedAt` | ISO string | `complete`, `failed` |
| `commitSha` | string (40 hex) | `complete`; `failed` if the clone succeeded |
| `jsFilesScanned` | integer | `complete` |
| `counts` | `{ high, medium, low }` integers | `complete` |
| `score` | integer 0–100, or `null` when `jsFilesScanned` is 0 | `complete` |
| `grade` | `A` \| `B` \| `C` \| `D` \| `F` \| `N/A` | `complete` |
| `reportKey` | string | `complete` |
| `error` | short user-safe message, no stack trace | `failed` only |

### Counts and severities

`counts` keys are the scanner's severity values, lowercased: the scanner emits only `HIGH`, `MEDIUM`, `LOW`. Each finding counts once; the scanner can report several findings on one line (one per matching pattern), and each is counted.

### Files scanned

`jsFilesScanned` counts files with extensions `.js`, `.mjs`, `.cjs`, `.ts` (the provided scanner's defaults), excluding:

- any directory named `node_modules`
- any directory whose name starts with `.` (as the provided `scanDirectory` does; covers `.git`)
- files ending in `.min.js`

Clean files count; the worker walks the tree itself rather than using `scanDirectory`, which returns only files with findings.

### Grading

- `score = max(0, 100 − Σ(count × weight))`, weights `high 10`, `medium 4`, `low 1`.
- `A ≥ 90`, `B ≥ 80`, `C ≥ 70`, `D ≥ 60`, else `F`.
- `jsFilesScanned === 0` gives `grade: "N/A"`, `score: null`.

## Full report (S3)

Key: `s3://<BUCKET_NAME>/reports/<owner>/<name>/<scanId>.json` (lowercase `owner/name`, `Content-Type: application/json`). Written before the record is marked `complete`.

```json
{
  "version": 1,
  "repo": "owner/name",
  "scanId": "2026-10-21T18:04:11.532Z_a1b2c3",
  "commitSha": "3f2c9e1b7a...",
  "requestedAt": "2026-10-21T18:04:11.532Z",
  "completedAt": "2026-10-21T18:04:20.101Z",
  "jsFilesScanned": 42,
  "counts": { "high": 2, "medium": 5, "low": 1 },
  "score": 71,
  "grade": "C",
  "findings": [
    {
      "id": "HARDCODED_SECRET",
      "name": "Hardcoded Secret",
      "severity": "HIGH",
      "description": "Hardcoded password",
      "message": "Hardcoded secret detected. Move secrets to environment variables.",
      "file": "src/config.js",
      "line": 12,
      "column": 7,
      "evidence": "const password = \"...\";"
    }
  ]
}
```

Each entry in `findings` is a finding exactly as returned by the provided `scanFile`, except `file`, which is rewritten to a repo-relative path with `/` separators (the scanner returns the absolute temp-clone path). `line` and `column` are 1-based; `evidence` is the trimmed source line, truncated by the scanner to 100 characters plus `...`. Findings keep the scanner's order within a file (severity, then line); files are in sorted path order.

## Deviations from the spec

| # | Spec | This contract | Reason |
|---|---|---|---|
| 1 | `counts` has `critical, high, medium, low`; weight `critical 25` | `counts` is `{ high, medium, low }`; no critical weight | The scanner has no `CRITICAL` severity (Phase 0 §2). Decided: drop it rather than always report 0. |
| 2 | "Run the scanner on the clone's JavaScript files" | `.ts` files are scanned and counted in `jsFilesScanned` | Matches the scanner's default extensions (Phase 0 §3). Decided: include. The field name is kept for compatibility with the spec. |
| 3 | Exclude `node_modules`, `.git`, `*.min.js` | Also excludes every dot-directory (`.github`, `.vscode`, ...) | Matches the provided `scanDirectory`, so `/scan/directory` and repo scans agree. |
| 4 | Report shape unspecified beyond "complete findings plus summary" | Defined above; `file` made repo-relative | The scanner's `file` is whatever path it was given, which would leak temp paths (Phase 0 §2). |
| 5 | History response shape unspecified | `{ repo, scans: [...] }` | An object leaves room for pagination later without breaking clients. |
| 6 | Badge "latest completed grade, scanning, N/A, or unknown" | Precedence table above | A rescan in progress should not hide the last known grade. |

Not a contract change, but affects grades: the scanner's `WEAK_CRYPTO` and `INSECURE_FUNCTION` rules have heavy false positives (Phase 0, "Scanner accuracy"). Handling is an open decision; until it is made, grades use the scanner's findings as-is.
