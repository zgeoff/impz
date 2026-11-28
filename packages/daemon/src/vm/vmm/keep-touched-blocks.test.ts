import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureImpdLogs } from '../../test-utils/platform/capture-impd-logs';
import { buildImpPaths } from '../storage/build-imp-paths';
import { dropTouchedBlocks, keepTouchedBlocks } from './keep-touched-blocks';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'keep-touched-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const paths = buildImpPaths(directory, 'imp-1');

  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.snapshotDir, { recursive: true });

  return { paths, logs: captureImpdLogs() };
}

test("#keepTouchedBlocks keeps the handler run's blocks beside the memory file, as written", () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.uffdTouchedFile, Buffer.from([0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0]));
  keepTouchedBlocks(ctx.paths);

  expect([...readFileSync(ctx.paths.memTouched)]).toStrictEqual([
    0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0,
  ]);

  expect(existsSync(`${ctx.paths.memTouched}.new`)).toBeFalse();
});

test('#keepTouchedBlocks replaces the record of the memory file it follows', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.memTouched, Buffer.from([1, 1, 1]));
  writeFileSync(ctx.paths.uffdTouchedFile, Buffer.from([0, 1, 0]));
  keepTouchedBlocks(ctx.paths);

  expect([...readFileSync(ctx.paths.memTouched)]).toStrictEqual([0, 1, 0]);
});

test('#keepTouchedBlocks drops a stale record when the imp ran no handler', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.memTouched, Buffer.from([1, 1, 1]));
  keepTouchedBlocks(ctx.paths);

  expect(existsSync(ctx.paths.memTouched)).toBeFalse();
});

test('#keepTouchedBlocks keeps no record of a handler that left its file empty', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.memTouched, Buffer.from([1, 1, 1]));
  writeFileSync(ctx.paths.uffdTouchedFile, Buffer.alloc(0));
  keepTouchedBlocks(ctx.paths);

  expect(existsSync(ctx.paths.memTouched)).toBeFalse();
});

test('#keepTouchedBlocks logs a record it cannot keep, and leaves none', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.uffdTouchedFile, Buffer.from([1]));
  rmSync(ctx.paths.snapshotDir, { recursive: true });
  keepTouchedBlocks(ctx.paths);

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.startsWith('WARNING impd.imps imp=imp-1 kept no record of the blocks the wake served: '),
  );

  expect(existsSync(ctx.paths.memTouched)).toBeFalse();
});

test('#dropTouchedBlocks removes the record, and ignores a missing one', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.memTouched, Buffer.from([1]));
  dropTouchedBlocks(ctx.paths);
  dropTouchedBlocks(ctx.paths);

  expect(existsSync(ctx.paths.memTouched)).toBeFalse();
});
