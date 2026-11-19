// DynamoDB-backed scan store and SQS-backed job queue.
// Same interface as the in-memory versions in store.js, so routes don't change.
// Table layout and record fields: docs/contracts.md "Scan record (DynamoDB)".
import crypto from 'node:crypto';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

const HISTORY_LIMIT = 20;
const PAGE_SIZE = 25;

export const createDynamoStore = ({ ddb, tableName }) => {
  if (!tableName) throw new Error('TABLE_NAME is required');

  // Newest-first query on one repo (scanIds sort chronologically).
  const query = (repo, extra = {}) => ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: '#repo = :repo',
    ExpressionAttributeNames: { '#repo': 'repo', ...extra.names },
    ExpressionAttributeValues: { ':repo': repo, ...extra.values },
    ScanIndexForward: false,
    ...extra.params,
  }));

  return {
    async createScan(repo) {
      const requestedAt = new Date().toISOString();
      const scan = {
        repo,
        scanId: `${requestedAt}_${crypto.randomBytes(3).toString('hex')}`,
        status: 'queued',
        requestedAt,
      };
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: scan,
        // Never overwrite an existing record on an id collision.
        ConditionExpression: 'attribute_not_exists(scanId)',
      }));
      return scan;
    },

    async getLatest(repo) {
      const { Items = [] } = await query(repo, { params: { Limit: 1 } });
      return Items[0] ?? null;
    },

    // DynamoDB applies Limit BEFORE a FilterExpression, so "Limit 1 + filter"
    // can miss a complete scan behind newer queued ones. Page through instead.
    async getLatestComplete(repo) {
      let ExclusiveStartKey;
      do {
        const page = await query(repo, {
          names: { '#status': 'status' }, // status is a DynamoDB reserved word
          values: { ':complete': 'complete' },
          params: { FilterExpression: '#status = :complete', Limit: PAGE_SIZE, ExclusiveStartKey },
        });
        if (page.Items?.length) return page.Items[0];
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return null;
    },

    async getHistory(repo) {
      const { Items = [] } = await query(repo, { params: { Limit: HISTORY_LIMIT } });
      return Items;
    },

    // Used by the worker (running -> complete | failed) and by the API when queueing fails.
    // Only updates a record that exists; returns null otherwise.
    async updateScan(repo, scanId, fields) {
      const entries = Object.entries(fields).filter(([key]) => key !== 'repo' && key !== 'scanId');
      if (!entries.length) throw new Error('updateScan needs at least one field');
      const names = {};
      const values = {};
      const sets = entries.map(([key, value], i) => {
        names[`#f${i}`] = key;
        values[`:v${i}`] = value;
        return `#f${i} = :v${i}`;
      });
      try {
        const { Attributes } = await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { repo, scanId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(scanId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }));
        return Attributes;
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') return null;
        throw error;
      }
    },
  };
};

export const createSqsQueue = ({ sqs, queueUrl }) => {
  if (!queueUrl) throw new Error('QUEUE_URL is required');
  return {
    async send(message) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }));
    },
  };
};
