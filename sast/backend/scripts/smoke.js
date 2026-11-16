// Smoke test for the data layer: round-trips DynamoDB, SQS, and S3 through aws/clients.js.
//
// Run against the local emulator from the repo root (uses .env unchanged):
//   docker compose run --rm api npm run smoke
// `run` starts the emulator first and waits until init.sh has created the resources
// (depends_on: service_healthy). Stop it afterwards with `docker compose down`.
//
// Uses throwaway keys under repo "smoke/<random>" and deletes everything it writes.
// Exits non-zero on the first failure.

import { randomBytes } from 'node:crypto';
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getClients, getConfig, reportKey } from '../aws/clients.js';

const config = getConfig();
const { sqs, ddb, s3 } = getClients();

const suffix = randomBytes(3).toString('hex');
const repo = `smoke/${suffix}`;
const scanId = `${new Date().toISOString()}_${suffix}`;

const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    // Connection errors (e.g. emulator not running) have an empty message but a code
    const reason = error.message || error.code || error.name;
    console.error(`FAIL  ${name}: ${reason}`);
    process.exitCode = 1;
    throw error;
  }
};

const assertEqual = (actual, expected, what) => {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const dynamodb = async () => {
  const item = { repo, scanId, status: 'queued', requestedAt: new Date().toISOString() };
  await ddb.send(new PutCommand({ TableName: config.tableName, Item: item }));
  try {
    // Same query the API uses for "latest scan" (docs/contracts.md)
    const { Items } = await ddb.send(new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'repo = :repo',
      ExpressionAttributeValues: { ':repo': repo },
      ScanIndexForward: false,
      Limit: 1,
    }));
    assertEqual(Items?.[0]?.scanId, scanId, 'latest scanId');
    assertEqual(Items[0].status, 'queued', 'status');
  } finally {
    await ddb.send(new DeleteCommand({ TableName: config.tableName, Key: { repo, scanId } }));
  }
};

const sqsRoundTrip = async () => {
  const body = JSON.stringify({ version: 1, scanId, repo, smoke: true });
  await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: body }));

  // The queue may hold real jobs: find ours, and release any others immediately.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: config.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    }));
    let found = false;
    for (const message of Messages) {
      if (message.Body === body) {
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: config.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }));
        found = true;
      } else {
        await sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: config.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }));
      }
    }
    if (found) return;
  }
  throw new Error('sent message was not received');
};

const s3RoundTrip = async () => {
  const Key = reportKey(repo, scanId);
  const report = JSON.stringify({ version: 1, repo, scanId, findings: [] });
  await s3.send(new PutObjectCommand({
    Bucket: config.bucketName,
    Key,
    Body: report,
    ContentType: 'application/json',
  }));
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bucketName, Key }));
    assertEqual(object.ContentType, 'application/json', 'ContentType');
    assertEqual(await object.Body.transformToString(), report, 'report body');
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key }));
  }
};

console.log(`Smoke test against ${config.endpoint ?? `AWS (${config.region})`}`);
try {
  await check(`DynamoDB ${config.tableName}: put, latest-scan query, delete`, dynamodb);
  await check(`SQS ${config.queueUrl.split('/').pop()}: send, receive, delete`, sqsRoundTrip);
  await check(`S3 ${config.bucketName}: put report, get, delete`, s3RoundTrip);
  console.log('All checks passed');
} catch {
  // Already reported by check(); exitCode is set.
}
