import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRunPrefix } from '../../../testing/platform/format-run-prefix';
import { readRunOwner } from '../../../testing/platform/read-run-owner';
import { readHostLoad } from './read-host-load';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const procRoot = mkdtempSync(join(tmpdir(), `${prefix}imp-host-load-`));

  onTestFinished(() => {
    rmSync(procRoot, { recursive: true, force: true });
  });

  return { procRoot };
}

test('it reads the stall totals of PSI and the steal of /proc/stat in microseconds', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, 'pressure'));

  writeFileSync(
    join(ctx.procRoot, 'pressure', 'cpu'),
    'some avg10=1.52 avg60=0.80 avg300=0.21 total=7340021\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
  );

  writeFileSync(
    join(ctx.procRoot, 'pressure', 'io'),
    'some avg10=0.31 avg60=0.12 avg300=0.04 total=902113\nfull avg10=0.20 avg60=0.08 avg300=0.02 total=611870\n',
  );

  writeFileSync(
    join(ctx.procRoot, 'pressure', 'memory'),
    'some avg10=0.00 avg60=0.00 avg300=0.00 total=1450\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=980\n',
  );

  writeFileSync(
    join(ctx.procRoot, 'stat'),
    'cpu  48210 12 20931 4019283 3302 0 1180 2754 0 0\ncpu0 6021 1 2610 502390 410 0 301 344 0 0\nintr 9128301 0 9 0\n',
  );

  expect(readHostLoad(ctx.procRoot)).toStrictEqual({
    cpuStallUs: 7_340_021,
    ioStallUs: 902_113,
    memoryStallUs: 1450,
    stealUs: 27_540_000,
  });
});

test('it gives no stall totals on a kernel without PSI', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.procRoot, 'stat'), 'cpu  48210 12 20931 4019283 3302 0 1180 2754 0 0\n');

  expect(readHostLoad(ctx.procRoot)).toStrictEqual({
    cpuStallUs: null,
    ioStallUs: null,
    memoryStallUs: null,
    stealUs: 27_540_000,
  });
});

test('it gives no steal for a /proc/stat whose cpu line has no steal column', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.procRoot, 'stat'), 'cpu  48210 12 20931 4019283 3302 0 1180\n');

  expect(readHostLoad(ctx.procRoot).stealUs).toBeNull();
});
