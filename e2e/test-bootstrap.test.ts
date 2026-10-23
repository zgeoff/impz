import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubSlowCommand } from '@impz/test-utils/create-stub-slow-command';
import { waitFor } from '@impz/test-utils/wait-for';
import { REPO_ROOT } from './lib/instance';

// Bun runs onTestFinished callbacks first in, first out; the stack closes last in, first out,
// so a harness the test spawns stops before the directory its stand-ins live in goes.
function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = mkdtempSync(join(tmpdir(), 'imp-test-bootstrap-'));

  stack.defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { stack, directoryPath: directory };
}

test.each([
  ['no arguments', [], 'test-bootstrap: give --image REF or --stub\n'],
  [
    '--health with the stub',
    ['--stub', '--health'],
    'test-bootstrap: --health needs a real --image\n',
  ],
  ['an unknown flag', ['--stub', '--foo'], 'test-bootstrap: unknown argument: --foo\n'],
])('it exits 2 through the bash wrapper for %s', (_label, argv, stderr) => {
  const result = Bun.spawnSync(['bash', join(REPO_ROOT, 'e2e', 'test-bootstrap.sh'), ...argv]);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 2, stdout: '', stderr });
});

test('it prints the usage through the bash wrapper for --help', () => {
  const result = Bun.spawnSync(['bash', join(REPO_ROOT, 'e2e', 'test-bootstrap.sh'), '--help']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: expect.toStartWith('Run deploy/bootstrap.sh for real inside a throwaway container'),
  });
});

test('it lets the running command finish on SIGTERM, then runs no other and exits 143', async () => {
  const ctx = setupTest();
  const docker = createStubSlowCommand(ctx.directoryPath, 'docker');

  const harness = Bun.spawn(
    ['bash', join(REPO_ROOT, 'e2e', 'test-bootstrap.sh'), '--image', 'imp-host:dev-test'],
    { env: { ...process.env, PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  ctx.stack.defer(async () => {
    harness.kill('SIGKILL');

    await harness.exited;
  });

  await waitFor(
    () => {
      if (readFileSync(docker.log, 'utf8') === '') {
        throw new Error('docker has not started');
      }
    },
    { label: 'the first docker call' },
  );

  harness.kill('SIGTERM');

  writeFileSync(docker.release, '');

  const exitCode = await harness.exited;

  expect(exitCode).toBe(143);

  expect(readFileSync(docker.log, 'utf8')).toBe(
    'docker image inspect imp-host:dev-test started\ndocker image inspect imp-host:dev-test finished\n',
  );
});
