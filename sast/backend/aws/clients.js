// Shared AWS SDK v3 clients (SQS, DynamoDB, S3). The only place AWS clients are constructed.
//
// Locally, AWS_ENDPOINT_URL points every client at the emulator (see .env.example).
// On real AWS it is unset and the SDK uses the normal regional endpoints and
// credentials (Learner Lab session / task role). The SDK reads AWS_ENDPOINT_URL
// itself; it is passed explicitly here so the behaviour is obvious and testable.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';

const config = () => {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
  };
};

let cached;

export const getClients = () => {
  if (!cached) {
    const base = config();
    cached = {
      // Document client: plain JS objects in and out; drop undefined fields.
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient(base), {
        marshallOptions: { removeUndefinedValues: true },
      }),
      sqs: new SQSClient(base),
      // Emulators serve buckets by path (http://host:4566/bucket), not subdomain.
      s3: new S3Client({ ...base, forcePathStyle: Boolean(base.endpoint) }),
    };
  }
  return cached;
};
