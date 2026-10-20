import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubKsmExec } from './create-stub-ksm-exec';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'stub-ksm-exec-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it records the command it was asked to exec, one argument a line', () => {
  const ctx = setupTest();
  const wrapper = createStubKsmExec(ctx.directoryPath);

  Bun.spawnSync([wrapper.path, 'jailer', '--id', 'a b']);

  expect(wrapper.readArgv()).toStrictEqual(['jailer', '--id', 'a b']);
});

test('it fails as an exec that never started', () => {
  const ctx = setupTest();
  const wrapper = createStubKsmExec(ctx.directoryPath);
  const result = Bun.spawnSync([wrapper.path, 'jailer']);

  expect(result.exitCode).toBe(1);
});
