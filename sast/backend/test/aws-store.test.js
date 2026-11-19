// Unit tests for the DynamoDB/SQS adapters, with fake clients that record commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDynamoStore, createSqsQueue } from '../aws/scan-store.js';

const fakeClient = (responder = () => ({})) => {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      return responder(command, calls.length);
    },
  };
};

test('createScan puts a queued record with a contract-format scanId, never overwriting', async () => {
  const ddb = fakeClient();
  const scan = await createDynamoStore({ ddb, tableName: 'scans' }).createScan('o/r');
  assert.match(scan.scanId, /^\d{4}-\d\d-\d\dT[\d:.]+Z_[0-9a-f]{6}$/);
  assert.equal(scan.status, 'queued');
  const [call] = ddb.calls;
  assert.equal(call.name, 'PutCommand');
  assert.equal(call.input.TableName, 'scans');
  assert.deepEqual(call.input.Item, scan);
  assert.equal(call.input.ConditionExpression, 'attribute_not_exists(scanId)');
});

test('getLatest and getHistory query newest first with the right limits', async () => {
  const ddb = fakeClient(() => ({ Items: [{ scanId: 'b' }, { scanId: 'a' }] }));
  const store = createDynamoStore({ ddb, tableName: 'scans' });
  assert.deepEqual(await store.getLatest('o/r'), { scanId: 'b' });
  await store.getHistory('o/r');
  for (const { input } of ddb.calls) {
    assert.equal(input.ScanIndexForward, false);
    assert.deepEqual(input.ExpressionAttributeValues, { ':repo': 'o/r' });
  }
  assert.equal(ddb.calls[0].input.Limit, 1);
  assert.equal(ddb.calls[1].input.Limit, 20);
});

test('getLatest returns null for a repo with no records', async () => {
  const store = createDynamoStore({ ddb: fakeClient(() => ({ Items: [] })), tableName: 'scans' });
  assert.equal(await store.getLatest('o/none'), null);
});

test('getLatestComplete pages past filtered-out records until it finds one', async () => {
  // Page 1: everything filtered out but more pages remain; page 2 has the hit.
  const ddb = fakeClient((cmd, n) => (n === 1
    ? { Items: [], LastEvaluatedKey: { repo: 'o/r', scanId: 'x' } }
    : { Items: [{ scanId: 'old', status: 'complete', grade: 'A' }] }));
  const scan = await createDynamoStore({ ddb, tableName: 'scans' }).getLatestComplete('o/r');
  assert.equal(scan.grade, 'A');
  assert.equal(ddb.calls.length, 2);
  assert.deepEqual(ddb.calls[1].input.ExclusiveStartKey, { repo: 'o/r', scanId: 'x' });
  assert.equal(ddb.calls[0].input.FilterExpression, '#status = :complete');
  assert.equal(ddb.calls[0].input.ExpressionAttributeNames['#status'], 'status');
});

test('getLatestComplete returns null when no page has a complete scan', async () => {
  const store = createDynamoStore({ ddb: fakeClient(() => ({ Items: [] })), tableName: 'scans' });
  assert.equal(await store.getLatestComplete('o/r'), null);
});

test('updateScan sets only the given fields, guarded by existence', async () => {
  const ddb = fakeClient(() => ({ Attributes: { repo: 'o/r', scanId: 's', status: 'running' } }));
  const out = await createDynamoStore({ ddb, tableName: 'scans' }).updateScan('o/r', 's', { status: 'running', repo: 'ignored' });
  assert.equal(out.status, 'running');
  const { input } = ddb.calls[0];
  assert.deepEqual(input.Key, { repo: 'o/r', scanId: 's' });
  assert.equal(input.UpdateExpression, 'SET #f0 = :v0');
  assert.deepEqual(input.ExpressionAttributeNames, { '#f0': 'status' });
  assert.equal(input.ConditionExpression, 'attribute_exists(scanId)');
});

test('updateScan returns null for a record that does not exist', async () => {
  const ddb = fakeClient(() => { const e = new Error('nope'); e.name = 'ConditionalCheckFailedException'; throw e; });
  assert.equal(await createDynamoStore({ ddb, tableName: 'scans' }).updateScan('o/r', 's', { status: 'failed' }), null);
});

test('SQS queue sends the job message as JSON to QUEUE_URL', async () => {
  const sqs = fakeClient();
  const msg = { version: 1, scanId: 's', repo: 'o/r', repoUrl: 'https://github.com/o/r', requestedAt: 't' };
  await createSqsQueue({ sqs, queueUrl: 'http://q/scan-jobs' }).send(msg);
  assert.equal(sqs.calls[0].name, 'SendMessageCommand');
  assert.equal(sqs.calls[0].input.QueueUrl, 'http://q/scan-jobs');
  assert.deepEqual(JSON.parse(sqs.calls[0].input.MessageBody), msg);
});

test('adapters refuse to start without their resource names', () => {
  assert.throws(() => createDynamoStore({ ddb: fakeClient() }), /TABLE_NAME/);
  assert.throws(() => createSqsQueue({ sqs: fakeClient() }), /QUEUE_URL/);
});
