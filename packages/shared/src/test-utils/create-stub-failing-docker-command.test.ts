import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createStubFailingDockerCommand } from './create-stub-failing-docker-command';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'stub-failing-docker-command-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it fails the named subcommand and never runs the real command', () => {
  const ctx = setupTest();
  const real = createStubBin(join(ctx.directory, 'real'), 'docker');
  const stub = createStubFailingDockerCommand(ctx.directory, 'history', real.path);
  const result = Bun.spawnSync([join(stub.bin, 'docker'), 'history', 'sha256:example']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'stub docker: history fails\n',
  });

  expect(real.readCalls()).toStrictEqual([]);
});

test('it passes any other subcommand to the real command with its arguments', () => {
  const ctx = setupTest();

  const real = createStubBin(join(ctx.directory, 'real'), 'docker', {
    script: `#!/bin/bash\nprintf '<%s>\\n' "$@"`,
  });

  const stub = createStubFailingDockerCommand(ctx.directory, 'history', real.path);
  const result = Bun.spawnSync([join(stub.bin, 'docker'), 'image', 'inspect', 'two words']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '<image>\n<inspect>\n<two words>\n',
    stderr: '',
  });
});
