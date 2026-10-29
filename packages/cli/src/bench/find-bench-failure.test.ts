import { expect, test } from 'bun:test';
import { findBenchFailure } from './find-bench-failure';

test('it finds no failure in timed results under the limit', () => {
  const results = [
    {
      scenario: 'wake',
      concurrency: 1,
      samples: 3,
      failures: {},
      latencyMs: { p50: 140, p95: 180, p99: 180, max: 180 },
      impdMs: null,
      memFileMib: null,
    },
  ];

  expect(findBenchFailure(results, 500)).toBeNull();
});

test('it fails a concurrency whose median passes the limit', () => {
  const results = [
    {
      scenario: 'wake-young',
      concurrency: 4,
      samples: 4,
      failures: {},
      latencyMs: { p50: 793, p95: 1100, p99: 1100, max: 1100 },
      impdMs: null,
      memFileMib: null,
    },
  ];

  expect(findBenchFailure(results, 500)).toBe(
    'bench: the median wake-young at 4 took 793ms, past 500ms',
  );
});

test('it fails a concurrency that took no sample, with or without a limit', () => {
  const results = [
    {
      scenario: 'create',
      concurrency: 64,
      samples: 0,
      failures: { RAM_BUDGET_EXCEEDED: 64 },
      latencyMs: null,
      impdMs: null,
      memFileMib: null,
    },
  ];

  expect(findBenchFailure(results, null)).toBe('bench: create at 64 took no sample');
});
