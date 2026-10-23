import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubMountpoint } from './create-stub-mountpoint';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-mountpoint-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it reports a path it was not given as a mount', () => {
  const ctx = setupTest();
  const stub = createStubMountpoint(ctx.directoryPath, ['/var/lib/imp']);
  const result = Bun.spawnSync([join(stub.bin, 'mountpoint'), '-q', '/data']);

  expect(result.exitCode).toBe(0);
});

test('it reports each path it was given as no mount', () => {
  const ctx = setupTest();
  const stub = createStubMountpoint(ctx.directoryPath, ['/var/lib/imp', '/srv/imp']);

  const exitCodes = [
    Bun.spawnSync([join(stub.bin, 'mountpoint'), '-q', '/var/lib/imp']).exitCode,
    Bun.spawnSync([join(stub.bin, 'mountpoint'), '-q', '/srv/imp']).exitCode,
  ];

  expect(exitCodes).toStrictEqual([1, 1]);
});

test('it matches a path that holds a space and a quote as written', () => {
  const ctx = setupTest();
  const stub = createStubMountpoint(ctx.directoryPath, ["/tmp/it's here"]);

  const exitCodes = [
    Bun.spawnSync([join(stub.bin, 'mountpoint'), '-q', "/tmp/it's here"]).exitCode,
    Bun.spawnSync([join(stub.bin, 'mountpoint'), '-q', '/tmp/it']).exitCode,
  ];

  expect(exitCodes).toStrictEqual([1, 0]);
});

test('it logs each call with its arguments', () => {
  const ctx = setupTest();
  const stub = createStubMountpoint(ctx.directoryPath, ['/var/lib/imp']);

  Bun.spawnSync([join(stub.bin, 'mountpoint'), '-q', '/var/lib/imp']);

  expect(readFileSync(stub.calls, 'utf8')).toBe('mountpoint -q /var/lib/imp\n');
});
