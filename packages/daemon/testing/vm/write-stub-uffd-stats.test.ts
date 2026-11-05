import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStubUffdStats } from './write-stub-uffd-stats';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'stub-uffd-stats-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { statsFile: join(directory, 'uffd.stats') };
}

// the handler's Go tests write the same golden file for these counts
test('it writes the counts in the layout the page handler writes', () => {
  const ctx = setupTest();

  writeStubUffdStats(ctx.statsFile, { faults: 214, blocks: 151, serveNs: 388_400_000 });

  expect(readFileSync(ctx.statsFile)).toStrictEqual(
    readFileSync(new URL('../../../../host/uffd-handler/testdata/stats.golden', import.meta.url)),
  );
});
