# 0001: LocalStack for local development

## Context

The target deployment uses SQS, DynamoDB, and S3 on AWS Learner Lab, whose credentials rotate every session. The team needs to develop and test the full pipeline without depending on a live AWS account.

## Options considered

- Develop directly against Learner Lab resources
- LocalStack emulating SQS, DynamoDB, and S3 in one container
- Separate emulators (ElasticMQ, DynamoDB Local, MinIO)

## Decision

Use LocalStack, run by `docker compose`, with resources created by `infra/localstack/init.sh`. The same code targets real AWS by leaving `AWS_ENDPOINT_URL` unset. If LocalStack's free tier requires an account or auth token, revisit in favor of the separate emulators.

## Consequences

- No AWS credentials needed for local work or CI.
- All AWS clients are built in `aws/clients.js` so the endpoint override lives in one place.
- Emulator behavior can differ slightly from real AWS; Milestone 3 must verify against the real services.
