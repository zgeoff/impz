import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
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

  createStubMountpoint(ctx.directoryPath, ['/var/lib/imp']);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'mountpoint'), '-q', '/data']);

  expect(result.exitCode).toBe(0);
});

test('it reports each path it was given as no mount', () => {
  const ctx = setupTest();

  createStubMountpoint(ctx.directoryPath, ['/var/lib/imp', '/srv/imp']);

  const exitCodes = [
    Bun.spawnSync([join(ctx.directoryPath, 'mountpoint'), '-q', '/var/lib/imp']).exitCode,
    Bun.spawnSync([join(ctx.directoryPath, 'mountpoint'), '-q', '/srv/imp']).exitCode,
  ];

  expect(exitCodes).toStrictEqual([1, 1]);
});

test('it matches a path that holds a space and a quote as written', () => {
  const ctx = setupTest();

  createStubMountpoint(ctx.directoryPath, ["/tmp/it's here"]);

  const exitCodes = [
    Bun.spawnSync([join(ctx.directoryPath, 'mountpoint'), '-q', "/tmp/it's here"]).exitCode,
    Bun.spawnSync([join(ctx.directoryPath, 'mountpoint'), '-q', '/tmp/it']).exitCode,
  ];

  expect(exitCodes).toStrictEqual([1, 0]);
});

test('it logs each call with its arguments', () => {
  const ctx = setupTest();

  createStubMountpoint(ctx.directoryPath, ['/var/lib/imp']);

  Bun.spawnSync([join(ctx.directoryPath, 'mountpoint'), '-q', '/var/lib/imp']);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('mountpoint -q /var/lib/imp\n');
});
