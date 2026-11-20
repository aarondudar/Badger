import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { runJob } from '../worker/pipeline.js';

const job = {
    version: 1,
    scanId: 'test-scan-001',
    repo: 'caleb/test-repo',
    repoUrl: 'https://github.com/caleb/test-repo',
    requestedAt: '2026-11-19T10:00:00.000Z',
};

const createFakeClients = () => {
    const dynamoCommands = [];
    const s3Commands = [];

    const record = {
        repo: job.repo,
        scanId: job.scanId,
        status: 'queued',
    };

    return {
        dynamoCommands,
        s3Commands,
        clients: {
            ddb: {
                send: async (command) => {
                    dynamoCommands.push(command);

                    if (command instanceof UpdateCommand) {
                        const names = command.input.ExpressionAttributeNames;
                        const values = command.input.ExpressionAttributeValues;

                        for (const [placeholder, field] of Object.entries(names)) {
                            const valuePlaceholder = placeholder.replace('#f', ':v');
                            record[field] = values[valuePlaceholder];
                        }

                        return {
                            Attributes: { ...record },
                        };
                    }

                    return {};
                },
            },
            s3: {
                send: async (command) => {
                    s3Commands.push(command);
                    return {};
                },
            },
        },
    };
};

test('runJob returns N/A when no supported files are scanned', async () => {
    const fake = createFakeClients();

    const result = await runJob(job, {
        clients: fake.clients,
        config: {
            tableName: 'badger-scans',
            bucketName: 'badger-reports',
        },
        clone: async () => ({
            repoDir: '/tmp/badger-test/repository',
            commitSha: 'b'.repeat(40),
            cleanup: async () => { },
        }),
        scan: async () => ({
            filesScanned: 0,
            results: {},
        }),
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.score, null);
    assert.equal(result.grade, 'N/A');
    assert.equal(result.jsFilesScanned, 0);
});

test('runJob completes a scan and saves the report', async () => {
    const fake = createFakeClients();
    let cleanupCalled = false;

    const result = await runJob(job, {
        clients: fake.clients,
        config: {
            tableName: 'badger-scans',
            bucketName: 'badger-reports',
        },
        clone: async () => ({
            repoDir: '/tmp/badger-test/repository',
            commitSha: 'a'.repeat(40),
            cleanup: async () => {
                cleanupCalled = true;
            },
        }),
        scan: async () => ({
            filesScanned: 2,
            results: {
                '/tmp/badger-test/repository/app.js': [
                    {
                        name: 'Hardcoded Secret',
                        severity: 'HIGH',
                        message: 'A hardcoded secret was found',
                        file: '/tmp/badger-test/repository/app.js',
                        line: 5,
                    },
                ],
            },
        }),
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.grade, 'A');
    assert.equal(result.score, 90);
    assert.equal(result.jsFilesScanned, 2);
    assert.deepEqual(result.counts, {
        high: 1,
        medium: 0,
        low: 0,
    });

    assert.equal(fake.s3Commands.length, 1);
    assert.ok(fake.s3Commands[0] instanceof PutObjectCommand);
    assert.equal(fake.s3Commands[0].input.Bucket, 'badger-reports');
    assert.equal(fake.s3Commands[0].input.ContentType, 'application/json');

    assert.equal(cleanupCalled, true);
});

test('runJob records failure and cleans up the repository', async () => {
    const fake = createFakeClients();
    let cleanupCalled = false;

    await assert.rejects(
        runJob(job, {
            clients: fake.clients,
            config: {
                tableName: 'badger-scans',
                bucketName: 'badger-reports',
            },
            clone: async () => ({
                repoDir: '/tmp/badger-test/repository',
                commitSha: 'c'.repeat(40),
                cleanup: async () => {
                    cleanupCalled = true;
                },
            }),
            scan: async () => {
                throw new Error('Internal scanner details');
            },
        }),
        /Internal scanner details/
    );

    assert.equal(cleanupCalled, true);

    const updates = fake.dynamoCommands.filter(
        (command) => command instanceof UpdateCommand
    );

    const failedUpdate = updates.find((command) =>
        Object.entries(command.input.ExpressionAttributeNames).some(
            ([placeholder, field]) =>
                field === 'status' &&
                command.input.ExpressionAttributeValues[
                placeholder.replace('#f', ':v')
                ] === 'failed'
        )
    );
    assert.ok(failedUpdate);



    const errorPlaceholder = Object.keys(
        failedUpdate.input.ExpressionAttributeNames
    ).find(
        (placeholder) =>
            failedUpdate.input.ExpressionAttributeNames[placeholder] === 'error'
    );

    assert.equal(
        failedUpdate.input.ExpressionAttributeValues[
        errorPlaceholder.replace('#f', ':v')
        ],
        'Repository scan failed. Please try again.'
    );
});