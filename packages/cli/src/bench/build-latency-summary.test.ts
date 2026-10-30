import { expect, test } from 'bun:test';
import { buildLatencySummary } from './build-latency-summary';

test('it picks each percentile as the nearest-ranked sample', () => {
  const samples = Array.from({ length: 100 }, (_, index) => 100 - index);

  expect(buildLatencySummary(samples)).toStrictEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
});

test('it reads every percentile of one sample as that sample', () => {
  expect(buildLatencySummary([142])).toStrictEqual({ p50: 142, p95: 142, p99: 142, max: 142 });
});

test('it ranks four samples so the tail percentiles read the slowest', () => {
  expect(buildLatencySummary([30, 10, 40, 20])).toStrictEqual({
    p50: 20,
    p95: 40,
    p99: 40,
    max: 40,
  });
});

test('it summarises no samples as nothing', () => {
  expect(buildLatencySummary([])).toBeNull();
});
