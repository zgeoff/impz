import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostPrivileges } from './read-host-privileges.ts';
import { readTextOrNull } from './read-text-or-null.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-privileges-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'deploy'));

  return { root: directory };
}

test("it swaps the deployed seccomp profile for the repo's own and adds each probed path that exists", () => {
  const ctx = setupTest();
  const present = join(ctx.root, 'present');

  writeFileSync(present, '');

  writeFileSync(
    join(ctx.root, 'deploy', 'imp-host.args.json'),
    JSON.stringify({
      lines: [['--rm', '--name', 'imp-host']],
      proxy: {
        privileges: [['--cap-drop', 'ALL']],
        lines: [['--rm', '--name', 'imp-docker-proxy']],
        command: ['/usr/local/bin/imp-docker-proxy'],
      },
      network: { name: 'imp', bridge: 'imp0' },
      addresses: 'hostname -I',
      privileges: [
        ['--cap-drop', 'ALL'],
        ['--security-opt', 'seccomp=/etc/imp/imp-host.seccomp.json'],
      ],
      probed: [
        { path: present, args: ['--device', '/dev/present'] },
        { path: join(ctx.root, 'absent'), args: ['--device', '/dev/absent'] },
      ],
    }),
  );

  expect(
    readHostPrivileges({ readText: readTextOrNull, probePath: existsSync }, ctx.root),
  ).toStrictEqual([
    '--cap-drop',
    'ALL',
    '--security-opt',
    `seccomp=${join(ctx.root, 'deploy', 'imp-host.seccomp.json')}`,
    '--device',
    '/dev/present',
  ]);
});

test('it refuses when the args file cannot be read', () => {
  expect(() =>
    readHostPrivileges({ readText: () => null, probePath: () => false }, '/w/imp'),
  ).toThrowWithMessage(Error, 'cannot read /w/imp/deploy/imp-host.args.json');
});
