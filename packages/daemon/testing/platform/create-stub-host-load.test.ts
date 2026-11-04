import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostLoad } from '../../src/platform/process/read-host-load';
import { createStubHostLoad } from './create-stub-host-load';
import { formatRunPrefix } from './format-run-prefix';
import { readRunOwner } from './read-run-owner';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const procRoot = mkdtempSync(join(tmpdir(), `${prefix}imp-stub-host-load-`));

  onTestFinished(() => {
    rmSync(procRoot, { recursive: true, force: true });
  });

  return { procRoot };
}

test('it writes proc files that readHostLoad reads back as the given load', () => {
  const ctx = setupTest();

  createStubHostLoad(ctx.procRoot, {
    cpuStallUs: 2_500_000,
    ioStallUs: 31_000,
    memoryStallUs: 0,
    stealUs: 640_000,
  });

  expect(readHostLoad(ctx.procRoot)).toStrictEqual({
    cpuStallUs: 2_500_000,
    ioStallUs: 31_000,
    memoryStallUs: 0,
    stealUs: 640_000,
  });
});
