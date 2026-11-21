import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { createStubRepoScript } from './create-stub-repo-script';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-repo-script-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory, stubs: join(directory, 'stubs') };
}

test('it returns the path of the script it writes in the scripts dir', () => {
  const ctx = setupTest();

  expect(createStubRepoScript(ctx.directoryPath, 'dev.sh', ctx.stubs)).toBe(
    join(ctx.directoryPath, 'dev.sh'),
  );
});

test('it records each call with its arguments among the calls of the kit stand-ins', () => {
  const ctx = setupTest();

  createStubBin(ctx.stubs, 'zpool');

  const script = createStubRepoScript(ctx.directoryPath, 'dev.sh', ctx.stubs);

  Bun.spawnSync([join(ctx.stubs, 'zpool'), 'list']);
  Bun.spawnSync([script, 'down', '--clean']);

  expect(formatStubCalls(readStubCalls(ctx.stubs))).toBe('zpool list\ndev.sh down --clean\n');
});

test('it keeps an argument with a quote, a backslash or a space whole', () => {
  const ctx = setupTest();
  const script = createStubRepoScript(ctx.directoryPath, 'dev.sh', ctx.stubs);

  Bun.spawnSync([script, String.raw`say "hi" \ there`, 'two words']);

  expect(readStubCalls(ctx.stubs).map((call) => call.argv)).toStrictEqual([
    [String.raw`say "hi" \ there`, 'two words'],
  ]);
});

test('it runs its body with the arguments after recording the call', () => {
  const ctx = setupTest();

  const script = createStubRepoScript(ctx.directoryPath, 'test-e2e.sh', ctx.stubs, {
    body: 'echo "ran $2"; exit 3',
  });

  const result = Bun.spawnSync([script, '--only', 'sleep']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 3,
    stdout: 'ran sleep\n',
  });

  expect(formatStubCalls(readStubCalls(ctx.stubs))).toBe('test-e2e.sh --only sleep\n');
});

test('it records the variables it was told to, empty when unset', () => {
  const ctx = setupTest();

  const script = createStubRepoScript(ctx.directoryPath, 'make-vmlinux.sh', ctx.stubs, {
    recordEnv: ['JOBS', 'KBUILD_MISSING'],
  });

  Bun.spawnSync([script, 'out'], { env: { JOBS: '5' } });

  expect(formatStubCalls(readStubCalls(ctx.stubs))).toBe(
    'make-vmlinux.sh out\n  JOBS=5 KBUILD_MISSING=\n',
  );
});

test('it exits 0 with no output when it has no body', () => {
  const ctx = setupTest();
  const result = Bun.spawnSync([createStubRepoScript(ctx.directoryPath, 'test-zfs.sh', ctx.stubs)]);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it records into a folder whose path holds a quote', () => {
  const ctx = setupTest();
  const stubs = join(ctx.directoryPath, "it's stubs");
  const script = createStubRepoScript(ctx.directoryPath, 'dev.sh', stubs);

  createStubBin(stubs, 'zpool');

  Bun.spawnSync([script, 'up']);

  expect(formatStubCalls(readStubCalls(stubs))).toBe('dev.sh up\n');
});
