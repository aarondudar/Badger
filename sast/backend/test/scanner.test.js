
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    scanDirectory,
    scanDirectoryWithStats,
} from '../scanner.js';

test('counts clean JavaScript files even when they have no findings', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));

    try {
        fs.writeFileSync(
            path.join(tempDir, 'clean.js'),
            'const greeting = "Hello world";\n'
        );

        const { results, filesScanned } = scanDirectoryWithStats(tempDir);

        assert.equal(filesScanned, 1);
        assert.deepEqual(results, {});
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('returns zero scanned files when a directory has no JavaScript files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));

    try {
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test repository');

        const { results, filesScanned } = scanDirectoryWithStats(tempDir);

        assert.equal(filesScanned, 0);
        assert.deepEqual(results, {});
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('preserves the original scanDirectory findings-object interface', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));

    try {
        fs.writeFileSync(
            path.join(tempDir, 'clean.js'),
            'const greeting = "Hello world";\n'
        );

        const results = scanDirectory(tempDir);

        assert.deepEqual(results, {});
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('does not count minified JavaScript files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));

    try {
        fs.writeFileSync(
            path.join(tempDir, 'app.js'),
            'const greeting = "Hello world";\n'
        );
        fs.writeFileSync(
            path.join(tempDir, 'bundle.min.js'),
            'const minified = true;\n'
        );

        const { filesScanned } = scanDirectoryWithStats(tempDir);

        assert.equal(filesScanned, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
