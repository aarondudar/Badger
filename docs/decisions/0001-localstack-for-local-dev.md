# 0001: Emulated AWS for local development (Floci instead of LocalStack)

- Status: accepted
- Date: 2026-11-02

## Context

The target deployment uses SQS, DynamoDB, and S3 on AWS Learner Lab, whose credentials rotate every session. The team needs to develop and test the full pipeline, locally and in CI, without a live AWS account.

The spec planned LocalStack, with instructions to check its free-tier terms first. As of 2026-11-02:

- Since 2026-03-23, LocalStack ships a single image that requires an account and auth token (`LOCALSTACK_AUTH_TOKEN`), CI included. The temporary bypass ended in April 2026. The free plan still needs every teammate to register, and CI would need a stored token. ([LocalStack blog](https://blog.localstack.cloud/localstack-single-image-next-steps/))
- MinIO, the spec's fallback for S3, stopped publishing community images in October 2025 and its repo is archived.

## Options considered

1. **LocalStack free plan with tokens.** One container as planned, but every teammate needs an account, tokens become a secret in `.env` and in GitHub, and terms could change again.
2. **Pin a pre-March-2026 LocalStack tag.** No account needed, but frozen with no CVE fixes; LocalStack calls this short-term only.
3. **Separate emulators:** ElasticMQ (SQS), DynamoDB Local, and an S3 mock such as `adobe/s3mock`. No accounts, but three containers with three endpoints, and `init.sh` would need rewriting for each.
4. **Floci** (`floci/floci`, MIT): a LocalStack-compatible emulator. No account or token, same port (4566), same `/etc/localstack/init/ready.d/` hooks and `/_localstack/health` endpoint, and SQS, DynamoDB, and S3 run in one container. Actively released, but younger than LocalStack and less proven.
5. **MiniStack** (`ministackorg/ministack`, MIT): similar to Floci, also LocalStack-compatible. Smaller community; Floci was preferred for its larger user base and its documented fix for container hostnames in queue URLs.

## Decision

Use Floci, pinned to `floci/floci:2.3.0-compat` (the `-compat` variant includes the AWS CLI that `infra/localstack/init.sh` uses). `docker compose` runs it as the `localstack` service with `FLOCI_HOSTNAME=localstack`, so the SQS queue URL in `.env.example` resolves from the API and worker containers. The same application code targets real AWS by leaving `AWS_ENDPOINT_URL` unset.

Verified locally on 2026-11-02: the stack starts with no account or token; `init.sh` creates the queue, table, and bucket; and `get-queue-url` returns `http://localstack:4566/000000000000/scan-jobs`.

Names (the `localstack` service, `infra/localstack/`) are kept so that switching back to LocalStack, or to MiniStack, is a one-line image change.

## Consequences

- No AWS credentials or third-party accounts are needed for local work or CI.
- All AWS clients are built in `aws/clients.js`, so the endpoint override lives in one place.
- Emulator behavior can differ from real AWS, and Floci is less proven than LocalStack. Milestone 3 must verify the pipeline against the real services. If Floci misbehaves, try MiniStack first (also drop-in), then option 3.
- State is in memory: `docker compose down` discards queues, tables, and reports. `init.sh` recreates the resources on every start.
