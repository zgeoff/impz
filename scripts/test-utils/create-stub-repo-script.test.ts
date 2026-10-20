import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubRepoScript } from './create-stub-repo-script';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-repo-script-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it returns the path of the script it writes in the scripts dir', () => {
  const ctx = setupTest();
  const calls = join(ctx.directoryPath, 'calls');

  writeFileSync(calls, '');

  expect(createStubRepoScript(ctx.directoryPath, 'dev.sh', calls)).toBe(
    join(ctx.directoryPath, 'dev.sh'),
  );
});

test('it logs each call with its arguments to the calls file', () => {
  const ctx = setupTest();
  const calls = join(ctx.directoryPath, 'calls');

  writeFileSync(calls, 'zpool list\n');

  const script = createStubRepoScript(ctx.directoryPath, 'dev.sh', calls);

  Bun.spawnSync([script, 'down', '--clean']);

  expect(readFileSync(calls, 'utf8')).toBe('zpool list\ndev.sh down --clean\n');
});

test('it runs its body with the arguments after logging the call', () => {
  const ctx = setupTest();
  const calls = join(ctx.directoryPath, 'calls');

  writeFileSync(calls, '');

  const script = createStubRepoScript(
    ctx.directoryPath,
    'test-e2e.sh',
    calls,
    'echo "ran $2"; exit 3',
  );

  const result = Bun.spawnSync([script, '--only', 'sleep']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 3,
    stdout: 'ran sleep\n',
  });
});

test('it exits 0 with no output when it has no body', () => {
  const ctx = setupTest();
  const calls = join(ctx.directoryPath, 'calls');

  writeFileSync(calls, '');

  const result = Bun.spawnSync([createStubRepoScript(ctx.directoryPath, 'test-zfs.sh', calls)]);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it logs to a calls file whose path holds a quote', () => {
  const ctx = setupTest();
  const calls = join(ctx.directoryPath, "it's calls");

  writeFileSync(calls, '');

  Bun.spawnSync([createStubRepoScript(ctx.directoryPath, 'dev.sh', calls), 'up']);

  expect(readFileSync(calls, 'utf8')).toBe('dev.sh up\n');
});
