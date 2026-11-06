import { expect, test } from 'bun:test';
import { buildPassResult } from './build-pass-result';

test.each([
  { label: 'an error after 2 errors', outcome: 'error', errors: 2, expected: 3 },
  { label: 'an error after none', outcome: 'error', errors: 0, expected: 1 },
  { label: 'a change after 2 errors', outcome: 'changed', errors: 2, expected: 0 },
  { label: 'no change after 2 errors', outcome: 'unchanged', errors: 2, expected: 0 },
] as const)('it counts $expected errors in a row for $label', (row) => {
  const pass = buildPassResult({
    name: 'backup',
    passed: { outcome: row.outcome, summary: 'the backup ran' },
    consecutiveErrors: row.errors,
    savedOutcome: null,
    now: 1_800_000_000_000,
  });

  expect(pass.result).toStrictEqual({
    name: 'backup',
    outcome: row.outcome,
    summary: 'the backup ran',
    consecutiveErrors: row.expected,
    at: 1_800_000_000_000,
  });
});

test.each([
  { label: 'no saved outcome', saved: null, outcome: 'unchanged', shouldSave: true },
  { label: 'a different saved outcome', saved: 'error', outcome: 'unchanged', shouldSave: true },
  { label: 'the same saved outcome', saved: 'unchanged', outcome: 'unchanged', shouldSave: false },
  { label: 'the same saved error', saved: 'error', outcome: 'error', shouldSave: false },
] as const)('it answers shouldSave $shouldSave for $label', (row) => {
  const pass = buildPassResult({
    name: 'backup',
    passed: { outcome: row.outcome, summary: 'the backup ran' },
    consecutiveErrors: 0,
    savedOutcome: row.saved,
    now: 1_800_000_000_000,
  });

  expect(pass.shouldSave).toBe(row.shouldSave);
});
