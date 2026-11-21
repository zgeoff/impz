import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
import { createStubShellScript } from './create-stub-shell-script';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-shell-script-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it runs the stand-in when the script runs by its path, and records the call under its name', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'setup-net', {
    script: '#!/bin/bash\necho "ran $1"; exit 4',
  });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'setup-net.sh'), 'eth0']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 4,
    stdout: 'ran eth0\n',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('setup-net eth0\n');
});

test('it exits 0 with no output for a stand-in with no options', () => {
  const ctx = setupTest();

  createStubShellScript(ctx.directoryPath, 'tailscale-up');

  const result = Bun.spawnSync([join(ctx.directoryPath, 'tailscale-up.sh')]);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});
