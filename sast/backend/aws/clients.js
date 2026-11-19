// Shared AWS SDK v3 clients (SQS, DynamoDB, S3). The only place AWS clients are constructed.
//
// Locally, AWS_ENDPOINT_URL points every client at the emulator (Floci, docs/decisions/0001).
// On real AWS it is left unset and the SDK's default endpoints and credential chain apply.
//
// Usage:
//   import { getClients, getConfig, reportKey } from '../aws/clients.js';
//   const { sqs, ddb, s3 } = getClients();
//   const { queueUrl, tableName, bucketName } = getConfig();
//
// Nothing is built at import time, so modules (and their tests) can import this file
// without AWS configuration; the first getClients()/getConfig() call validates it.

import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";

const REQUIRED = ["AWS_REGION", "QUEUE_URL", "TABLE_NAME", "BUCKET_NAME"];

/**
 * Reads and validates AWS settings from the environment.
 * Throws listing every missing variable, so misconfiguration fails at startup, not mid-job.
 */
export const getConfig = (env = process.env) => {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return Object.freeze({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL || undefined,
    queueUrl: env.QUEUE_URL,
    tableName: env.TABLE_NAME,
    bucketName: env.BUCKET_NAME,
  });
};

/**
 * Builds a fresh set of clients from the given environment.
 * Application code should use getClients(); this is exported for tests.
 */
export const createClients = (env = process.env) => {
  const { region, endpoint } = getConfig(env);
  const base = endpoint ? { region, endpoint } : { region };

  const sqs = new SQSClient(base);
  const dynamodb = new DynamoDBClient(base);
  // Emulators serve S3 at <endpoint>/<bucket>, not <bucket>.<endpoint>.
  const s3 = new S3Client(endpoint ? { ...base, forcePathStyle: true } : base);

  // Plain JS objects in and out. Optional fields (e.g. `error`, `completedAt`) may be undefined.
  const ddb = DynamoDBDocumentClient.from(dynamodb, {
    marshallOptions: { removeUndefinedValues: true },
  });

  return { sqs, ddb, s3 };
};

let clients;

/** Returns the shared clients, creating them on first use. */
export const getClients = () => {
  clients ??= createClients();
  return clients;
};

/** S3 key of a scan's full report (docs/contracts.md, "Full report"). */
export const reportKey = (repo, scanId) => `reports/${repo}/${scanId}.json`;
