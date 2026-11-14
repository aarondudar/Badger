
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cloneRepo } from '../worker/clone.js';

test('rejects invalid repository URLs', async () => {
    await assert.rejects(
        cloneRepo('not-a-url'),
        /Invalid repository URL/
    );
});

test('rejects non-GitHub repository URLs', async () => {
    await assert.rejects(
        cloneRepo('https://gitlab.com/owner/repo'),
        /valid public HTTPS GitHub/
    );
});

test('rejects HTTP GitHub URLs', async () => {
    await assert.rejects(
        cloneRepo('http://github.com/owner/repo'),
        /valid public HTTPS GitHub/
    );
});

test('rejects GitHub URLs without an owner and repository', async () => {
    await assert.rejects(
        cloneRepo('https://github.com/owner'),
        /valid public HTTPS GitHub/
    );
});

test('rejects GitHub URLs containing credentials', async () => {
    await assert.rejects(
        cloneRepo('https://user:password@github.com/owner/repo'),
        /valid public HTTPS GitHub/
    );
});
