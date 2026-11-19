// Integration test against a real DynamoDB/SQS (the Floci emulator from docker compose).
// Skipped unless BADGER_AWS_IT=1. From the repo root, start the emulator:
//   docker compose up -d localstack
// then from sast/backend (one line, so nothing is lost when pasting):
//   export BADGER_AWS_IT=1 AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test TABLE_NAME=scans QUEUE_URL=http://localhost:4566/000000000000/scan-jobs BUCKET_NAME=scan-reports
//   npm test
// aws/clients.js requires all of AWS_REGION, QUEUE_URL, TABLE_NAME and BUCKET_NAME.
// Clean up afterwards: unset BADGER_AWS_IT AWS_ENDPOINT_URL AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY TABLE_NAME QUEUE_URL BUCKET_NAME
import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.BADGER_AWS_IT === '1';
const opts = { skip: enabled ? false : 'set BADGER_AWS_IT=1 to run against the emulator' };

test('DynamoDB store round-trip against the emulator', opts, async () => {
  const { getClients } = await import('../aws/clients.js');
  const { createDynamoStore } = await import('../aws/scan-store.js');
  const store = createDynamoStore({ ddb: getClients().ddb, tableName: process.env.TABLE_NAME });
  const repo = `it-${Date.now()}/repo`; // unique per run, so reruns don't collide
  const wait = () => new Promise((r) => setTimeout(r, 5));

  assert.equal(await store.getLatest(repo), null);
  const first = await store.createScan(repo);
  await store.updateScan(repo, first.scanId, { status: 'complete', grade: 'B', score: 84, counts: { high: 1, medium: 1, low: 2 } });
  // 30 newer queued scans: more than one query page, all filtered out by getLatestComplete.
  for (let i = 0; i < 30; i += 1) { await wait(); await store.createScan(repo); }

  const latest = await store.getLatest(repo);
  assert.equal(latest.status, 'queued');
  const complete = await store.getLatestComplete(repo);
  assert.equal(complete.scanId, first.scanId);
  assert.deepEqual(complete.counts, { high: 1, medium: 1, low: 2 });

  const history = await store.getHistory(repo);
  assert.equal(history.length, 20);
  assert.equal(history[0].scanId, latest.scanId);
  assert.ok(history.every((s, i) => i === 0 || history[i - 1].scanId > s.scanId), 'newest first');

  assert.equal(await store.updateScan(repo, 'missing', { status: 'failed' }), null);
});

test('SQS queue delivers the job message', opts, async () => {
  const { ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
  const { getClients } = await import('../aws/clients.js');
  const { createSqsQueue } = await import('../aws/scan-store.js');
  const { sqs } = getClients();
  const QueueUrl = process.env.QUEUE_URL;
  const msg = { version: 1, scanId: `it-${Date.now()}`, repo: 'it/repo', repoUrl: 'https://github.com/it/repo', requestedAt: new Date().toISOString() };
  await createSqsQueue({ sqs, queueUrl: QueueUrl }).send(msg);

  // The worker may be running and consume it first; look for ours for a few seconds.
  for (let i = 0; i < 5; i += 1) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    const mine = Messages.find((m) => JSON.parse(m.Body).scanId === msg.scanId);
    if (mine) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: mine.ReceiptHandle }));
      assert.deepEqual(JSON.parse(mine.Body), msg);
      return;
    }
  }
  assert.fail('job message not received (is the worker consuming the queue?)');
});
