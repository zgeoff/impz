import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { probeUnshare } from './probe-unshare';

test('it answers yes for a failing command when host tests are required', () => {
  updateEnv('IMP_HOST_TESTS', 'required');

  expect(probeUnshare(['false'])).toBeTrue();
});

test('it answers no for a command that fails in the namespace', () => {
  updateEnv('IMP_HOST_TESTS', undefined);

  expect(probeUnshare(['false'])).toBeFalse();
});

test('it answers no for a command that does not exist', () => {
  updateEnv('IMP_HOST_TESTS', undefined);

  expect(probeUnshare(['imp-no-such-command'])).toBeFalse();
});

test.skipIf(Bun.spawnSync(['unshare', '-rn', 'true']).exitCode !== 0)(
  'it answers yes for a command that succeeds in the namespace',
  () => {
    updateEnv('IMP_HOST_TESTS', undefined);

    expect(probeUnshare(['true'])).toBeTrue();
  },
);

test.skipIf(Bun.spawnSync(['unshare', '-rn', 'true']).exitCode !== 0)(
  'it prints a notice that names the failed command, so the skip is not silent',
  () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `import { probeUnshare } from ${JSON.stringify(join(import.meta.dir, 'probe-unshare.ts'))}; probeUnshare(['sh', '-c', 'echo no hl match >&2; exit 4']);`,
      ],
      { env: { PATH: process.env['PATH'] ?? '' } },
    );

    expect({
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }).toStrictEqual({
      exitCode: 0,
      stdout: '',
      stderr: [
        'probe-unshare: its tests skip, as this fails in a network namespace (IMP_HOST_TESTS=required fails them instead): ["sh","-c","echo no hl match >&2; exit 4"]',
        'no hl match',
        '',
      ].join('\n'),
    });
  },
);
