import { expect, test } from 'bun:test';
import { formatBenchCompare } from './format-bench-compare';

test('it compares each arm with the first, on the median of its rounds', () => {
  const table = formatBenchCompare([
    {
      arm: 'baseline',
      json: '{"results":[{"scenario":"wake","concurrency":4,"samples":20,"failures":{},"latencyMs":{"p50":200,"p95":400,"p99":600,"max":600}}]}',
    },
    {
      arm: 'candidate',
      json: '{"results":[{"scenario":"wake","concurrency":4,"samples":20,"failures":{"RAM_BUDGET_EXCEEDED":1},"latencyMs":{"p50":150,"p95":300,"p99":450,"max":450}}]}',
    },
    {
      arm: 'baseline',
      json: '{"results":[{"scenario":"wake","concurrency":4,"samples":20,"failures":{},"latencyMs":{"p50":220,"p95":440,"p99":660,"max":660}}]}',
    },
    {
      arm: 'candidate',
      json: '{"results":[{"scenario":"wake","concurrency":4,"samples":20,"failures":{},"latencyMs":{"p50":160,"p95":320,"p99":480,"max":480}}]}',
    },
    {
      arm: 'baseline',
      json: '{"results":[{"scenario":"wake","concurrency":4,"samples":20,"failures":{"RAM_BUDGET_EXCEEDED":2},"latencyMs":{"p50":210,"p95":420,"p99":630,"max":630}}]}',
    },
    {
      arm: 'candidate',
      json: '{"results":[{"scenario":"wake","concurrency":4,"samples":20,"failures":{},"latencyMs":{"p50":155,"p95":310,"p99":465,"max":465}}]}',
    },
  ]);

  expect(table).toMatchInlineSnapshot(`
    "| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95 | baseline p99 | candidate p99 | baseline failed | candidate failed |
    | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
    | wake | 4 | 210ms | 155ms (-26%) | 420ms | 310ms (-26%) | 630ms | 465ms (-26%) | 2 | 1 |"
  `);
});

test('it shows a dash for an arm that took no sample', () => {
  const table = formatBenchCompare([
    {
      arm: 'baseline',
      json: '{"results":[{"scenario":"create","concurrency":64,"samples":20,"failures":{},"latencyMs":{"p50":900,"p95":1200,"p99":1500,"max":1500}}]}',
    },
    {
      arm: 'candidate',
      json: '{"results":[{"scenario":"create","concurrency":64,"samples":0,"failures":{},"latencyMs":null}]}',
    },
  ]);

  expect(table).toMatchInlineSnapshot(`
    "| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95 | baseline p99 | candidate p99 | baseline failed | candidate failed |
    | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
    | create | 64 | 900ms | - | 1200ms | - | 1500ms | - | 0 | 0 |"
  `);
});
