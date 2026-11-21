import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
import { createStubProcessTable } from './create-stub-process-table';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-process-table-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the state of a process it was given', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, { processes: { tailscaled: 'S' } });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'ps'), '-C', 'tailscaled', '-o', 'stat=']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'S\n',
  });
});

test('it prints nothing and fails for a process it was not given, as ps does', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, { processes: { tailscaled: 'S' } });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'ps'), '-C', 'dockerd', '-o', 'stat=']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it ends a process on pkill, so ps no longer finds it', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, { processes: { tailscaled: 'S' } });

  const killed = Bun.spawnSync([join(ctx.directoryPath, 'pkill'), '-x', 'tailscaled']);
  const listed = Bun.spawnSync([join(ctx.directoryPath, 'ps'), '-C', 'tailscaled', '-o', 'stat=']);

  expect(killed.exitCode).toBe(0);

  expect({ exitCode: listed.exitCode, stdout: listed.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it leaves the other processes running on pkill', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, {
    processes: { tailscaled: 'S', dockerd: 'R' },
  });

  Bun.spawnSync([join(ctx.directoryPath, 'pkill'), '-x', 'tailscaled']);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'ps'), '-C', 'dockerd', '-o', 'stat=']);

  expect(result.stdout.toString()).toBe('R\n');
});

test('it still ends the process but exits 1 on pkill when told to fail', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, {
    processes: { tailscaled: 'S' },
    pkillFails: true,
  });

  const killed = Bun.spawnSync([join(ctx.directoryPath, 'pkill'), '-x', 'tailscaled']);
  const listed = Bun.spawnSync([join(ctx.directoryPath, 'ps'), '-C', 'tailscaled', '-o', 'stat=']);

  expect(killed.exitCode).toBe(1);

  expect({ exitCode: listed.exitCode, stdout: listed.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it logs the calls of ps and pkill to one calls file, in order', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, { processes: { tailscaled: 'S' } });

  Bun.spawnSync([join(ctx.directoryPath, 'ps'), '-C', 'tailscaled', '-o', 'stat=']);
  Bun.spawnSync([join(ctx.directoryPath, 'pkill'), '-x', 'tailscaled']);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'ps -C tailscaled -o stat=\npkill -x tailscaled\n',
  );
});
