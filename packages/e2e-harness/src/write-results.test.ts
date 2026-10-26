import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeResults } from './write-results';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-results-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it records each section with its verdict and its duration in milliseconds', () => {
  const ctx = setupTest();

  writeResults([{ index: 14, name: 'offsets', verdict: 'PASS', durationMs: 520 }], {
    resultsFile: join(ctx.directory, 'results.json'),
    metricsFile: join(ctx.directory, 'metrics.jsonl'),
    ramBudgetMib: 6144,
    idleTimeoutS: 10,
    now: () => new Date('2026-10-20T08:00:00.000Z'),
  });

  const written: unknown = JSON.parse(readFileSync(join(ctx.directory, 'results.json'), 'utf8'));

  expect(written).toStrictEqual({
    runAt: '2026-10-20T08:00:00.000Z',
    ramBudgetMib: 6144,
    idleTimeoutS: 10,
    section14: { name: 'offsets', verdict: 'PASS', durationMs: 520 },
  });
});

test('it adds every metric the suites appended', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'metrics.jsonl'),
    '{"https_issue_ms":1234}\n{"cpuLimitedShare":{"share":0.5}}\n',
  );

  writeResults([], {
    resultsFile: join(ctx.directory, 'results.json'),
    metricsFile: join(ctx.directory, 'metrics.jsonl'),
    ramBudgetMib: 6144,
    idleTimeoutS: 10,
    now: () => new Date('2026-10-20T08:00:00.000Z'),
  });

  const written: unknown = JSON.parse(readFileSync(join(ctx.directory, 'results.json'), 'utf8'));

  expect(written).toStrictEqual({
    runAt: '2026-10-20T08:00:00.000Z',
    ramBudgetMib: 6144,
    idleTimeoutS: 10,
    https_issue_ms: 1234,
    cpuLimitedShare: { share: 0.5 },
  });
});
