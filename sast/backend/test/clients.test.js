import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClients, getConfig, reportKey } from '../aws/clients.js';

const BASE_ENV = Object.freeze({
  AWS_REGION: 'us-east-1',
  QUEUE_URL: 'http://localstack:4566/000000000000/scan-jobs',
  TABLE_NAME: 'scans',
  BUCKET_NAME: 'scan-reports',
});
const LOCAL_ENV = Object.freeze({ ...BASE_ENV, AWS_ENDPOINT_URL: 'http://localstack:4566' });

test('getConfig reads names from the environment', () => {
  assert.deepEqual(getConfig(LOCAL_ENV), {
    region: 'us-east-1',
    endpoint: 'http://localstack:4566',
    queueUrl: 'http://localstack:4566/000000000000/scan-jobs',
    tableName: 'scans',
    bucketName: 'scan-reports',
  });
});

test('getConfig lists every missing required variable', () => {
  assert.throws(
    () => getConfig({ AWS_REGION: 'us-east-1' }),
    /Missing required environment variables: QUEUE_URL, TABLE_NAME, BUCKET_NAME/
  );
});

test('getConfig treats an empty AWS_ENDPOINT_URL as unset', () => {
  assert.equal(getConfig({ ...BASE_ENV, AWS_ENDPOINT_URL: '' }).endpoint, undefined);
});

test('with AWS_ENDPOINT_URL, every client targets the emulator', async () => {
  const { sqs, ddb, s3 } = createClients(LOCAL_ENV);

  for (const client of [sqs, ddb, s3]) {
    const endpoint = await client.config.endpoint();
    assert.equal(endpoint.hostname, 'localstack');
    assert.equal(endpoint.port, 4566);
    assert.equal(await client.config.region(), 'us-east-1');
  }
  assert.equal(s3.config.forcePathStyle, true);
});

test('without AWS_ENDPOINT_URL, clients use default AWS endpoints', async () => {
  const { sqs, ddb, s3 } = createClients(BASE_ENV);

  for (const client of [sqs, ddb, s3]) {
    assert.equal(client.config.endpoint, undefined);
    assert.equal(client.config.isCustomEndpoint, false);
    assert.equal(await client.config.region(), 'us-east-1');
  }
  assert.equal(s3.config.forcePathStyle, false);
});

test('reportKey matches the S3 layout in docs/contracts.md', () => {
  assert.equal(
    reportKey('owner/name', '2026-10-21T18:04:11.532Z_a1b2c3'),
    'reports/owner/name/2026-10-21T18:04:11.532Z_a1b2c3.json'
  );
});
