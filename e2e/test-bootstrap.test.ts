import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubBin } from '../scripts/test-utils/create-stub-bin';
import { REPO_ROOT } from './lib/instance';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-test-bootstrap-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
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

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    ['echo "$1 started" >>"$STUB_CALLS"', 'sleep 1', 'echo "$1 finished" >>"$STUB_CALLS"'].join(
      '\n',
    ),
  );

  const harness = Bun.spawn(
    ['bash', join(REPO_ROOT, 'e2e', 'test-bootstrap.sh'), '--image', 'imp-host:dev-test'],
    { env: { ...process.env, PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  await waitFor(
    () => {
      if (!readFileSync(docker.calls, 'utf8').includes('image started')) {
        throw new Error('docker has not started');
      }
    },
    { label: 'the first docker call' },
  );

  harness.kill('SIGTERM');

  const exitCode = await harness.exited;

  expect(exitCode).toBe(143);

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    'docker image inspect imp-host:dev-test\nimage started\nimage finished\n',
  );
});
