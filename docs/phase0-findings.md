# Phase 0 Findings: Provided SAST Scanner

Inspection of `sast/backend/` as imported from [aanchan/cs6620](https://github.com/aanchan/cs6620) at commit `9df1cf6`, per `SKELETON_SPEC.md` section 2. Behavior described below was verified by running the scanner locally (Node v25.9.0).

## Summary

| # | Question | Finding | Impact on spec |
|---|---|---|---|
| 1 | Is scanning importable? | Yes: `scanCode`, `scanFile`, `scanDirectory` exported from `scanner.js` | No scanner refactor needed; `server.js` needs a small app/listen split for tests |
| 2 | Report shape | Flat finding objects; severities `HIGH`, `MEDIUM`, `LOW` only | No `critical`; contract must change |
| 3 | Directory scan scope | `.js .mjs .cjs .ts`; skips `node_modules` and all dot-dirs; does not skip `*.min.js`; returns only files with findings | Worker must enumerate files itself |
| 4 | Secret patterns | Password pattern is permissive; key/token patterns require 16+ alphanumerics, no underscores | Constrains fixture strings |
| 5 | Node and dependencies | ESM, `express ^4.18.2`, `cors ^2.8.5`, no `engines`, no test runner | Use `node:test`, Node LTS image |

Additionally, several rules produce heavy false positives (see [Scanner accuracy](#scanner-accuracy)), which will dominate grades on real repos.

## 1. How scanning is implemented

`scanner.js` holds an array of rules (`vulnerabilityRules`), each with an `id`, `name`, `severity`, `message`, and a list of regex `patterns`. It exports:

- `scanCode(code, filename = 'untitled.js')`: runs every pattern over the string and returns an array of findings, sorted by severity then line.
- `scanFile(filepath)`: reads the file and calls `scanCode` with the path as the filename. Throws if the file is missing.
- `scanDirectory(dirpath, extensions)`: recursive walk, calling `scanFile` on matching files.

The route handlers in `server.js` only call these functions and assemble a response, so **no refactor of the scanning logic is required**.

One structural issue: `server.js` calls `app.listen()` at module load and does not export `app`. Regression tests for the existing routes need to import the app without binding a port. Proposed minimal change: move the app into `app.js` (exported), and keep `server.js` as the entrypoint that imports it and calls `listen`. Routes and responses stay identical.

## 2. Report shape

Each finding returned by `scanCode` / `scanFile`:

```json
{
  "id": "HARDCODED_SECRET",
  "name": "Hardcoded Secret",
  "severity": "HIGH",
  "description": "Hardcoded password",
  "message": "Hardcoded secret detected. Move secrets to environment variables.",
  "file": "path/as/passed/to/scanFile.js",
  "line": 12,
  "column": 7,
  "evidence": "const password = \"...\";"
}
```

- `line` is 1-based. `evidence` is the trimmed source line, truncated to 100 characters plus `...`.
- `file` is whatever path was passed in. For a clone in a temp directory this is an absolute temp path; the worker must make it repo-relative before storing.
- **Severity values are `HIGH`, `MEDIUM`, `LOW` only.** There is no `CRITICAL` rule. The spec's `counts.critical` and its weight of 25 have nothing to map to.

The existing routes wrap findings like this:

- `POST /scan/code` and `POST /scan/file`: `{ success, filename | filepath, scannedAt, summary: { totalVulnerabilities, high, medium, low }, vulnerabilities: [...] }`
- `POST /scan/directory`: `{ success, dirpath, scannedAt, summary: { filesScanned, totalVulnerabilities, high, medium, low }, results: { "<path>": [findings] } }`

Note that `summary.filesScanned` in `/scan/directory` is actually the number of files **with findings**, not files scanned (see section 3).

### Rules

| Rule ID | Severity | Patterns |
|---|---|---|
| `HARDCODED_SECRET` | HIGH | 8 |
| `NOSQL_INJECTION` | HIGH | 6 |
| `XSS` | HIGH | 6 |
| `PATH_TRAVERSAL` | HIGH | 4 |
| `SQL_INJECTION` | HIGH | 6 |
| `INSECURE_FUNCTION` | HIGH | 6 |
| `INSECURE_RANDOM` | MEDIUM | 2 |
| `SENSITIVE_DATA_LOG` | MEDIUM | 3 |
| `HARDCODED_IP` | MEDIUM | 2 |
| `WEAK_CRYPTO` | MEDIUM | 5 |
| `SECURITY_TODO` | LOW | 5 |

Each matching pattern produces its own finding, so one line can yield several findings. `GET /vulnerabilities` returns a hand-written list that is not generated from these rules (it currently matches them, but could drift).

## 3. Directory scan scope

- Default extensions: `.js`, `.mjs`, `.cjs`, **and `.ts`**. The spec says "JavaScript files"; we should decide whether TypeScript counts toward `jsFilesScanned`.
- Skips directories named `node_modules` and **any directory starting with `.`** (so `.git` is covered, but so are `.github`, `.vscode`, etc.).
- **Does not skip `*.min.js`.** The spec requires excluding minified bundles.
- **Returns only files that have findings.** Clean files are absent from the result, so the number of files scanned cannot be recovered from the return value.

Consequence: the worker should do its own file walk (applying the spec's exclusions), count the files, and call `scanFile` on each. This reuses the provided scanner without changing `scanDirectory`'s behavior for the existing route.

## 4. Hardcoded-secret patterns (for fixtures)

| Pattern | Matches | Fixture-safe example |
|---|---|---|
| `(password\|passwd\|pwd)\s*[:=]\s*['"][^'"]{4,}['"]` | Any 4+ char quoted value | `const password = "FAKE_PASSWORD_FOR_TESTS";` ✅ |
| `(api[_-]?key\|apikey)\s*[:=]\s*['"][a-zA-Z0-9]{16,}['"]` | 16+ **alphanumerics only** | `const api_key = "fakeapikeyfortests0001";` ✅ |
| `(secret[_-]?key\|secretkey)…[a-zA-Z0-9]{16,}` | Same | `const secret_key = "fakesecretkeyfortests01";` |
| `(access[_-]?token\|accesstoken)…[a-zA-Z0-9]{16,}` | Same | `const access_token = "fakeaccesstokenfortests1";` |
| AWS key ID / secret, Stripe `sk_live_`, GitHub `ghp_` | Real key shapes | **Do not use** (push protection risk, per spec) |

Verified: `api_key = "FAKE_API_KEY_FOR_TESTS"` does **not** match, because underscores are outside `[a-zA-Z0-9]`.

## 5. Node version and dependencies

- `"type": "module"` (ESM), entry `server.js`.
- Dependencies: `express ^4.18.2`, `cors ^2.8.5`. No dev dependencies.
- No `engines` field, so the Docker base should be the current Node LTS slim image; CI is set to Node 24.
- No test runner and no tests. Plan: Node's built-in `node:test`.
- `test-vulnerable.js` is a sample vulnerable file, not a test. Node's default `--test` glob matches `test-*.js` and would execute it, so the `npm test` script is scoped to `test/**/*.test.js`.

## Scanner accuracy

Several rules match far more than intended. Verified examples:

| Input | Reported | Cause |
|---|---|---|
| `describe("x", () => {});` | WEAK_CRYPTO (MEDIUM) | `/DES\|RC4\|RC2\|Blowfish/gi`: case-insensitive, no word boundaries |
| `list.includes(a)` | WEAK_CRYPTO (MEDIUM) | Same ("in**cludes**" contains "des") |
| `const nodes = [];` | WEAK_CRYPTO (MEDIUM) | Same |
| `// …grades, and badges…` | WEAK_CRYPTO (MEDIUM) | Same; fires inside comments |
| `re.exec(s)` | INSECURE_FUNCTION (HIGH) | `/\bexec\s*\(/` matches `RegExp.prototype.exec` |
| `Math.random(); // session token` | INSECURE_RANDOM × 2 | Two patterns overlap and both fire |
| `/* security note */` | SECURITY_TODO (LOW) | Any block comment mentioning "security" |

Scale: scanning the provided `scanner.js` itself yields 73 findings, 60 of them `WEAK_CRYPTO`. The stub `routes/repo.js` already gets one finding from the word "grades" in a comment.

**Impact on grading:** with the spec's weights (medium = 4), around three false `WEAK_CRYPTO` hits drop a repo below an A, and a typical real project with tests (`describe`) and array code (`includes`) will score D or F regardless of actual security. The `clean-js` fixture can only reach an A if it avoids common words containing "des" and any `.exec(` call.

## Open decisions

1. **Missing critical severity.** Recommended: drop `critical` from `counts` and the weights, grading on `high`, `medium`, `low`. Alternative: keep `critical: 0` to match the spec's shape.
2. **Scanner false positives.** Options:
   - Leave the scanner unchanged (strictest reading of "extend, not replace") and accept skewed grades.
   - Fix the patterns (word boundaries on cipher names, exclude `.exec(` method calls, de-duplicate overlapping rules) in a separate, clearly labeled commit.
   - Leave the rules alone but weight or filter specific rule IDs in our grading code.
3. **TypeScript.** Whether `.ts` files count toward `jsFilesScanned` and the grade.

## Next steps (pending decisions)

- Split `server.js` into `app.js` + `server.js` and add regression tests for existing routes.
- Write `docs/contracts.md` with the real report shape and the deviations above.
- Implement the worker's file walk with the spec's exclusions (`node_modules`, `.git`, `*.min.js`).
- Check LocalStack's current free-tier terms before pinning an image.
