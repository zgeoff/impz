import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeTransparentHugePages } from './probe-transparent-huge-pages';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-thp-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test.each(['always [madvise] never', '[always] madvise never', 'always madvise [never]'])(
  'it reads the host setting %s',
  (setting) => {
    const ctx = setupTest();
    const file = join(ctx.directoryPath, 'enabled');

    writeFileSync(file, `${setting}\n`);

    expect(probeTransparentHugePages(file)).toBe(!setting.includes('[never]'));
  },
);

test('it finds no transparent huge pages on a kernel built without them', () => {
  const ctx = setupTest();

  expect(probeTransparentHugePages(join(ctx.directoryPath, 'enabled'))).toBeFalse();
});
