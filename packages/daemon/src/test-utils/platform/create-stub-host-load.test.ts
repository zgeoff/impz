import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRunPrefix } from '@impz/testing/stand-in/platform/format-run-prefix';
import { readRunOwner } from '@impz/testing/stand-in/platform/read-run-owner';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { readHostLoad } from '../../platform/process/read-host-load';
import { readText } from '../../platform/process/read-text';
import { createStubHostLoad } from './create-stub-host-load';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const procRoot = mkdtempSync(join(tmpdir(), `${prefix}imp-stub-host-load-`));

  onTestFinished(() => {
    rmSync(procRoot, { recursive: true, force: true });
  });

  const sources = {
    procRoot,
    readFile: readText,
    logger: getImpdLogger('imps'),
  };

  return { procRoot, sources };
}

test('it writes proc files that readHostLoad reads back as the given load', () => {
  const ctx = setupTest();

  createStubHostLoad(ctx.procRoot, {
    cpuStallUs: 2_500_000,
    ioStallUs: 31_000,
    memoryStallUs: 0,
    stealUs: 640_000,
    thpFaultAlloc: 812,
    thpFaultFallback: 4,
    compactStall: 0,
  });

  expect(readHostLoad(ctx.sources)).toStrictEqual({
    cpuStallUs: 2_500_000,
    ioStallUs: 31_000,
    memoryStallUs: 0,
    stealUs: 640_000,
    thpFaultAlloc: 812,
    thpFaultFallback: 4,
    compactStall: 0,
  });
});
