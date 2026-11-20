import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

import { getClients, getConfig } from '../aws/clients.js';
import { createDynamoStore } from '../aws/scan-store.js';
import { runJob } from './pipeline.js';

const POLL_SECONDS = 20;
const VISIBILITY_TIMEOUT = 180;

export const createWorker = ({
  sqs,
  queueUrl,
  store,
  processJob = runJob,
  logger = console,
}) => {
  let stopping = false;

  const stop = () => {
    stopping = true;
  };

  const processMessage = async (message) => {
    let job;

    try {
      job = JSON.parse(message.Body);
    } catch {
      logger.error('Invalid JSON in SQS message. Leaving it for retry.');
      return;
    }

    if (
      !job ||
      typeof job.repo !== 'string' ||
      typeof job.scanId !== 'string'
    ) {
      logger.error('SQS job is missing repo or scanId. Leaving it for retry.');
      return;
    }

    try {
      if (job.version !== 1) {
        throw new Error('Unsupported scan job version');
      }

      const result = await processJob(job);

      if (result?.status !== 'complete') {
        throw new Error('Scan did not reach complete status');
      }

      logger.info(`Scan completed: ${job.repo} (${job.scanId})`);
    } catch (error) {
      logger.error(`Scan failed: ${job.repo} (${job.scanId})`, error);

      // Record failure before acknowledging the SQS message.
      const failed = await store.updateScan(job.repo, job.scanId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Repository scan failed. Please try again.',
      });

      if (!failed) {
        logger.error(`Could not record failed scan: ${job.scanId}`);
        return;
      }
    }

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    logger.info(`SQS message acknowledged: ${job.scanId}`);
  };

  const start = async () => {
    logger.info('Worker started. Listening for SQS scan jobs...');

    while (!stopping) {
      try {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: POLL_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT,
          }),
        );

        for (const message of Messages) {
          if (stopping) break;
          await processMessage(message);
        }
      } catch (error) {
        logger.error('Worker polling or processing error:', error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.info('Worker stopped.');
  };

  return { start, stop };
};

const main = async () => {
  const config = getConfig();
  const { sqs, ddb } = getClients();

  const store = createDynamoStore({
    ddb,
    tableName: config.tableName,
  });

  const worker = createWorker({
    sqs,
    queueUrl: config.queueUrl,
    store,
  });

  process.once('SIGINT', worker.stop);
  process.once('SIGTERM', worker.stop);

  await worker.start();
};

main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exitCode = 1;
});
