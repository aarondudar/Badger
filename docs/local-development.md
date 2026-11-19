# Local development

How to run Badger on your machine against emulated AWS, check what your code wrote, and test your part without the others' parts being finished. The architecture is in [`architecture.md`](architecture.md); message and record formats are in [`contracts.md`](contracts.md).

## Prerequisites

- Docker (with Compose v2)
- Node 26 (only for running tests or code outside containers)
- No AWS account or credentials. The emulator accepts the dummy `test` / `test` values in `.env.example`.

## First-time setup

From the repo root:

```sh
cp .env.example .env
cd sast/backend && npm ci && cd ../..
```

`.env` is gitignored. Don't put real credentials in it.

## Start and stop

```sh
docker compose up --build        # emulator, API (localhost:3000), and worker
docker compose up -d --wait localstack   # emulator only, in the background
docker compose down              # stop everything
```

- The `localstack` service runs **Floci**, a LocalStack-compatible emulator ([decision 0001](decisions/0001-localstack-for-local-dev.md)). On startup, `infra/localstack/init.sh` creates the `scan-jobs` queue and its dead-letter queue `scan-jobs-dlq`, the `scans` table, and the `scan-reports` bucket. The API and worker wait until that has finished.
- **Data is in memory.** `docker compose down` wipes every queue message, record, and report; the next start recreates empty resources.
- **Plain `up` runs the built image.** The code is copied into the image, so containers don't see your edits until you rebuild (`docker compose up --build api worker`). For day-to-day work, use dev mode instead.

### Dev mode (live reload)

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

This mounts `sast/backend` from your machine into the API and worker containers and runs them with `node --watch`, so saving a file restarts the process within a second or two. No rebuild needed, except after changing `package.json`. The mount is read-only, and the regular image is unchanged.

Tip: `alias dcdev='docker compose -f docker-compose.yml -f docker-compose.dev.yml'`, then `dcdev up --build`, `dcdev logs -f worker`, `dcdev down`.

## Check the data layer

```sh
docker compose run --rm api npm run smoke
```

This starts the emulator if needed, then writes, reads, and deletes a test item in DynamoDB, a message in SQS, and an object in S3 through `aws/clients.js`, and checks the dead-letter queue is wired up. If this fails, the problem is the environment, not your feature.

## Look inside the emulator

There is no web dashboard; use the AWS CLI that ships in the emulator container. Define this shortcut in your shell (run it from the repo root):

```sh
alias awslocal='docker compose exec localstack aws --endpoint-url http://localhost:4566'
```

| To see | Command |
|---|---|
| Resources exist | `awslocal sqs list-queues`, `awslocal dynamodb list-tables`, `awslocal s3 ls` |
| Scan records | `awslocal dynamodb scan --table-name scans --query 'Items[].{repo:repo.S,scanId:scanId.S,status:status.S,grade:grade.S,score:score.N}' --output table` |
| Latest record for one repo | `awslocal dynamodb query --table-name scans --key-condition-expression 'repo = :r' --expression-attribute-values '{":r":{"S":"owner/name"}}' --no-scan-index-forward --limit 1` |
| Jobs waiting in the queue | `awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/scan-jobs --attribute-names ApproximateNumberOfMessages` |
| Peek at a job (leaves it queued) | `awslocal sqs receive-message --queue-url http://localhost:4566/000000000000/scan-jobs --visibility-timeout 0 --query 'Messages[].Body' --output text` |
| Jobs in the dead-letter queue | Same two commands with `scan-jobs-dlq` in the queue URL |
| Queue settings (timeout, redrive) | `awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/scan-jobs --attribute-names VisibilityTimeout RedrivePolicy` |
| Stored reports | `awslocal s3 ls s3://scan-reports --recursive` |
| One report | `awslocal s3 cp s3://scan-reports/reports/owner/name/<scanId>.json -` |
| Service logs | `docker compose logs -f api worker` |
| Emulator health | `curl localhost:4566/_localstack/health` |

Always use `http://localhost:4566/...` as the queue URL in `awslocal` commands, since they run inside the emulator container. The queue URL the emulator *reports* (`http://localstack:4566/...`) is for the API and worker containers.

## Run your code outside a container

Faster than rebuilding, and you can use a debugger. Start the emulator only, then override the two settings that use the container hostname (values already in your shell take precedence over `--env-file`):

```sh
docker compose up -d --wait localstack
cd sast/backend
export AWS_ENDPOINT_URL=http://localhost:4566
export QUEUE_URL=http://localhost:4566/000000000000/scan-jobs
node --env-file=../../.env server.js          # API on localhost:3000
node --env-file=../../.env worker/index.js    # worker
```

## Testing your part on its own

### Worker

You don't need the API: do what it would do by hand. Write the `queued` record, then put a job on the queue in the format from [`contracts.md`](contracts.md#job-message-sqs), and watch the worker pick it up.

```sh
awslocal dynamodb put-item --table-name scans --item \
  '{"repo":{"S":"expressjs/cors"},"scanId":{"S":"2026-11-16T10:00:00.000Z_abc123"},"status":{"S":"queued"},"requestedAt":{"S":"2026-11-16T10:00:00.000Z"}}'

awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/scan-jobs \
  --message-body '{"version":1,"scanId":"2026-11-16T10:00:00.000Z_abc123","repo":"expressjs/cors","repoUrl":"https://github.com/expressjs/cors","requestedAt":"2026-11-16T10:00:00.000Z"}'
```

Then check the scan record goes `running` → `complete` (or `failed`), that the report is at `reports/expressjs/cors/2026-11-16T10:00:00.000Z_abc123.json`, and that the queue is empty again. Use a new `scanId` for each run, the same one in both commands.

#### Testing dead-lettering

A job the worker receives but never deletes (because it crashed, hung, or was killed) is retried, and after `MAX_RECEIVE_COUNT` (3) receives SQS moves it to `scan-jobs-dlq`. Expected failures (bad repo, clone timeout, oversized repo) should **not** end up there: the worker records them as `failed` and deletes the message.

1. In `.env`, set `QUEUE_VISIBILITY_TIMEOUT=10` so retries happen after 10 seconds instead of 5 minutes, then restart: `docker compose down && docker compose up --build`. Use the plain stack, not dev mode: the `worker` service restarts after a crash (`restart: on-failure`, like ECS replacing a task), and `node --watch` would stop that.
2. Make the worker crash on a job, for example with a temporary `process.exit(1)` after receiving.
3. Send a job, and watch `docker compose logs -f worker` show three attempts.
4. The job is now in `scan-jobs-dlq` and the main queue is empty. Its record is still `running`, so decide how the worker handles that case.

### API

You don't need the worker: stop it (`docker compose stop worker`) so jobs stay in the queue where you can see them.

```sh
curl -i -X POST localhost:3000/scan/repo -H 'Content-Type: application/json' \
  -d '{"repoUrl":"https://github.com/expressjs/cors"}'
```

Then check there's a `queued` record in `scans` and a matching job in the queue (peek command above). To test `GET /grade` and `GET /badge` responses for each status, write records by hand with `awslocal dynamodb put-item --table-name scans --item '{"repo":{"S":"demo/repo"},"scanId":{"S":"2026-11-16T10:05:00.000Z_def456"},"status":{"S":"complete"},"grade":{"S":"B"},"score":{"N":"84"}}'`.

### Unit tests

```sh
cd sast/backend && npm test
```

These don't need Docker or the emulator. CI runs the same command on every PR.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required environment variables` | `.env` is missing (run `cp .env.example .env`), or you're running Node without `--env-file` |
| `ECONNREFUSED` on port 4566 | The emulator isn't running: `docker compose up -d --wait localstack` |
| Port 4566 or 3000 already in use | Stop the other process, or a leftover stack: `docker compose down` |
| Container doesn't reflect your change | Rebuild (`docker compose up --build api worker`), or use [dev mode](#dev-mode-live-reload) |
| Changed `QUEUE_VISIBILITY_TIMEOUT` but nothing changed | Queue settings are applied at emulator startup: `docker compose down`, then up again |
| Dev mode: new package not found | Rebuild after changing `package.json`: add `--build` |
| Data from earlier is gone | Expected: the emulator keeps everything in memory |
| `awslocal: service "localstack" is not running` | Start the emulator first, and run the alias from the repo root |
