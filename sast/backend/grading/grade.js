// Pure grading functions: no I/O

export const SEVERITY_WEIGHTS = Object.freeze({
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
});

/**
 * Calculates a security score from vulnerability counts.
 * Each vulnerability reduces the score according to its severity.
 */
export const computeScore = (counts = {}) => {
  const penalty = Object.entries(SEVERITY_WEIGHTS).reduce(
    (total, [severity, weight]) => {
      const count = counts[severity] ?? 0;

      if (!Number.isInteger(count) || count < 0) {
        throw new TypeError(
          `Invalid vulnerability count for ${severity}`
        );
      }

      return total + count * weight;
    },
    0
  );

  return Math.max(0, 100 - penalty);
};

/**
 * Converts a numeric score into a letter grade.
 * A null score represents a scan with no JavaScript files.
 */
export const letterGrade = (score) => {
  if (score === null) return 'N/A';

  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError('Score must be between 0 and 100');
  }

  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';

  return 'F';
};
