import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeUffdDevice } from './probe-uffd-device';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-uffd-dev-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it finds a device it can read and write', () => {
  const ctx = setupTest();
  const device = join(ctx.directoryPath, 'userfaultfd');

  writeFileSync(device, '');

  expect(probeUffdDevice(device)).toBeTrue();
});

test('it finds no device where the host container has none', () => {
  const ctx = setupTest();

  expect(probeUffdDevice(join(ctx.directoryPath, 'userfaultfd'))).toBeFalse();
});
