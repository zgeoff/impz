import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/instance';

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
