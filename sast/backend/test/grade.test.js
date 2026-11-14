
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SEVERITY_WEIGHTS,
    computeScore,
    letterGrade,
} from '../grading/grade.js';

test('uses the expected severity weights', () => {
    assert.deepEqual(SEVERITY_WEIGHTS, {
        critical: 25,
        high: 10,
        medium: 4,
        low: 1,
    });
});

test('returns 100 for zero vulnerabilities', () => {
    assert.equal(computeScore({}), 100);
});

test('calculates weighted vulnerability penalties', () => {
    assert.equal(
        computeScore({
            critical: 1,
            high: 2,
            medium: 3,
            low: 4,
        }),
        39
    );
});

test('does not allow scores below zero', () => {
    assert.equal(computeScore({ critical: 10 }), 0);
});

test('rejects invalid vulnerability counts', () => {
    assert.throws(
        () => computeScore({ high: -1 }),
        TypeError
    );
});

test('assigns the correct letter grades at each threshold', () => {
    assert.equal(letterGrade(90), 'A');
    assert.equal(letterGrade(80), 'B');
    assert.equal(letterGrade(70), 'C');
    assert.equal(letterGrade(60), 'D');
    assert.equal(letterGrade(59), 'F');
});

test('returns N/A for a null score', () => {
    assert.equal(letterGrade(null), 'N/A');
});

test('rejects scores outside the valid range', () => {
    assert.throws(() => letterGrade(101), RangeError);
    assert.throws(() => letterGrade(-1), RangeError);
});
