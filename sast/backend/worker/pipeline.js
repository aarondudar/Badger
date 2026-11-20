import { PutObjectCommand } from '@aws-sdk/client-s3';

import { cloneRepo } from './clone.js';
import { scanDirectoryWithStats } from '../scanner.js';
import { computeScore, letterGrade } from '../grading/grade.js';
import { getClients, getConfig, reportKey } from '../aws/clients.js';
import { createDynamoStore } from '../aws/scan-store.js';
import path from 'node:path';

// Job pipeline: clone -> scan -> grade -> store
export const runJob = async (
  job,
  {
    clone = cloneRepo,
    scan = scanDirectoryWithStats,
    clients = getClients(),
    config = getConfig(),
  } = {}
) => {
  const store = createDynamoStore({
    ddb: clients.ddb,
    tableName: config.tableName,
  });

  // Validate the incoming job
  if (!job || job.version !== 1) {
    throw new Error('Invalid or unsupported scan job');
  }

  const { scanId, repo, repoUrl, requestedAt } = job;

  if (!scanId || !repo || !repoUrl || !requestedAt) {
    throw new Error('Scan job is missing required fields');
  }

  // The scan processing logic will go here
  let cloned;

  try {
    // Mark the scan as running
    await store.updateScan(repo, scanId, {
      status: 'running',
    });

    // Clone the GitHub repository
    cloned = await clone(repoUrl);

    // Scan the cloned repository
    const { results, filesScanned } = await scan(cloned.repoDir);
    // Convert scanner results into one findings array
    const findings = Object.entries(results)
      .sort(([fileA], [fileB]) => fileA.localeCompare(fileB))
      .flatMap(([file, fileFindings]) =>
        fileFindings.map((finding) => ({
          ...finding,
          file: path.relative(cloned.repoDir, file).split(path.sep).join('/'),
        }))
      );

    // Count findings by severity
    const counts = {
      high: 0,
      medium: 0,
      low: 0,
    };

    for (const finding of findings) {
      const severity = finding.severity.toLowerCase();

      if (Object.hasOwn(counts, severity)) {
        counts[severity]++;
      }
    }

    // Calculate the security score and letter grade
    const score = filesScanned === 0
      ? null
      : computeScore(counts);

    const grade = letterGrade(score);

    const completedAt = new Date().toISOString();
    // Build the complete scan report
    const report = {
      version: 1,
      repo,
      scanId,
      commitSha: cloned.commitSha,
      requestedAt,
      completedAt,
      jsFilesScanned: filesScanned,
      counts,
      score,
      grade,
      findings,
    };

    // Generate the S3 report location
    const key = reportKey(repo, scanId);

    // Save the full report as JSON in S3
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: JSON.stringify(report, null, 2),
        ContentType: 'application/json',
      })
    );

    // Mark the scan as complete in DynamoDB
    const completedScan = await store.updateScan(repo, scanId, {
      status: 'complete',
      completedAt,
      commitSha: cloned.commitSha,
      jsFilesScanned: filesScanned,
      counts,
      score,
      grade,
      reportKey: key,
    });

    // Return the completed scan result
    return {
      ...completedScan,
      report,
    };

  } catch (error) {
    // Record the failure in DynamoDB
    await store.updateScan(repo, scanId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      ...(cloned?.commitSha ? { commitSha: cloned.commitSha } : {}),
      error: 'Repository scan failed. Please try again.',
    });

    // Allow the worker to handle the failure
    throw error;
  } finally {
    // Always clean up the temporary cloned repository
    if (cloned) {
      await cloned.cleanup();
    }
  }
};