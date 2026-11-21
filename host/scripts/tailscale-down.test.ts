import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubProcessTable } from '@impz/scripts/test-utils/create-stub-process-table';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-tailscale-down-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    script: new URL('tailscale-down.sh', import.meta.url).pathname,
  };
}

test('it logs out, then stops tailscaled and waits until it is gone', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, { processes: { tailscaled: 'S' } });
  createStubBin(ctx.directoryPath, 'tailscale');
  createStubBin(ctx.directoryPath, 'sleep');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'tailscale-down: logged out, tailscaled stopped\n',
    stderr: '',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'ps -C tailscaled -o stat=',
    'tailscale --socket=/var/run/tailscale/tailscaled.sock logout',
    'pkill -x tailscaled',
    'ps -C tailscaled -o stat=',
    '',
  ]);
});

test('it does nothing but report when tailscaled does not run', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'ps');
  createStubBin(ctx.directoryPath, 'pkill');
  createStubBin(ctx.directoryPath, 'tailscale');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'tailscale-down: logged out, tailscaled stopped\n',
    stderr: '',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('ps -C tailscaled -o stat=\n');
});

test('it counts a zombie tailscaled as stopped', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'ps', { script: '#!/bin/bash\necho Z' });
  createStubBin(ctx.directoryPath, 'pkill');
  createStubBin(ctx.directoryPath, 'tailscale');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('ps -C tailscaled -o stat=\n');
});

test('it still stops tailscaled and exits 0 when the logout and the kill fail', () => {
  const ctx = setupTest();

  createStubProcessTable(ctx.directoryPath, { processes: { tailscaled: 'S' }, pkillFails: true });

  createStubBin(ctx.directoryPath, 'tailscale', {
    script: '#!/bin/bash\necho "logout failed" >&2; exit 1',
  });

  createStubBin(ctx.directoryPath, 'sleep');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'tailscale-down: logged out, tailscaled stopped\n',
    stderr: '',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'ps -C tailscaled -o stat=',
    'tailscale --socket=/var/run/tailscale/tailscaled.sock logout',
    'pkill -x tailscaled',
    'ps -C tailscaled -o stat=',
    '',
  ]);
});

test('it gives up waiting after 50 checks 0.1 s apart and still exits 0', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'ps', { script: '#!/bin/bash\necho S' });
  createStubBin(ctx.directoryPath, 'pkill');
  createStubBin(ctx.directoryPath, 'tailscale');
  createStubBin(ctx.directoryPath, 'sleep');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'ps -C tailscaled -o stat=',
    'tailscale --socket=/var/run/tailscale/tailscaled.sock logout',
    'pkill -x tailscaled',
    ...Array.from({ length: 50 }, () => ['ps -C tailscaled -o stat=', 'sleep 0.1']).flat(),
    '',
  ]);
});
