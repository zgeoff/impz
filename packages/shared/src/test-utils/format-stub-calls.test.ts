import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { formatStubCalls } from './format-stub-calls';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-format-stub-calls-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints one line per call, across the stand-ins of a folder, in call order', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker');
  createStubBin(ctx.directoryPath, 'systemctl');

  Bun.spawnSync(['bash', '-c', 'docker pull x; systemctl restart imp-host; docker ps'], {
    env: { PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` },
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'docker pull x\nsystemctl restart imp-host\ndocker ps\n',
  );
});

test('it prints nothing for a folder with no calls', () => {
  const ctx = setupTest();

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('');
});

test('it prints the variables a call recorded after it, and none for a call that recorded none', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'make', { recordEnv: ['JOBS', 'KBUILD_BUILD_USER'] });
  createStubBin(ctx.directoryPath, 'ls');

  Bun.spawnSync([join(ctx.directoryPath, 'make'), 'vmlinux'], { env: { JOBS: '5' } });
  Bun.spawnSync([join(ctx.directoryPath, 'ls'), '-l'], { env: { JOBS: '5' } });

  const calls = readStubCalls(ctx.directoryPath);

  expect(formatStubCalls(calls)).toBe('make vmlinux\n  JOBS=5\nls -l\n');
});
