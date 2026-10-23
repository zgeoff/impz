import { expect, test } from 'bun:test';
import { parseBootstrapArgs } from './parse-bootstrap-args';

test('it runs every distro with the stand-in image and the zfs leg, as CI does', () => {
  expect(parseBootstrapArgs(['--stub', '--zfs'])).toStrictEqual({
    kind: 'run',
    args: {
      image: null,
      stub: true,
      health: false,
      keep: false,
      zfs: true,
      distros: ['debian', 'ubuntu24', 'ubuntu26'],
    },
  });
});

test('it runs one distro with a release image, the health check and a kept container', () => {
  expect(
    parseBootstrapArgs(['--image', 'imp-host:1.2.3', '--health', '--keep', '--distro', 'ubuntu24']),
  ).toStrictEqual({
    kind: 'run',
    args: {
      image: 'imp-host:1.2.3',
      stub: false,
      health: true,
      keep: true,
      zfs: false,
      distros: ['ubuntu24'],
    },
  });
});

test('it keeps the last --distro when several are given', () => {
  const parsed = parseBootstrapArgs(['--stub', '--distro', 'debian', '--distro', 'ubuntu26']);

  expect(parsed).toMatchObject({ kind: 'run', args: { distros: ['ubuntu26'] } });
});

test('it takes the next word as the reference even when it looks like a flag, as bash did', () => {
  const parsed = parseBootstrapArgs(['--image', '--stub']);

  expect(parsed).toMatchObject({ kind: 'run', args: { image: '--stub', stub: false } });
});

test('it takes an inline --image value', () => {
  const parsed = parseBootstrapArgs(['--image=imp-host:dev']);

  expect(parsed).toMatchObject({ kind: 'run', args: { image: 'imp-host:dev' } });
});

test.each([
  ['--help', ['--help']],
  ['-h', ['-h']],
  ['--help with no image', ['--distro', 'debian', '--help']],
])('it asks for the usage with %s', (_label, argv) => {
  expect(parseBootstrapArgs(argv)).toStrictEqual({ kind: 'help' });
});

test.each([
  ['no arguments', [], 'give --image REF or --stub'],
  ['--health with the stub', ['--stub', '--health'], '--health needs a real --image'],
  [
    '--health with the stub and an image',
    ['--image', 'x', '--stub', '--health'],
    '--health needs a real --image',
  ],
  ['--image with no value', ['--stub', '--image'], '--image needs a reference'],
  ['--image with an empty value', ['--image='], '--image needs a reference'],
  ['--distro with no value', ['--stub', '--distro'], '--distro needs debian, ubuntu24 or ubuntu26'],
  [
    'an unknown distro',
    ['--stub', '--distro', 'fedora'],
    '--distro needs debian, ubuntu24 or ubuntu26',
  ],
  ['an unknown flag', ['--stub', '--foo'], 'unknown argument: --foo'],
  ['a positional word', ['--stub', 'debian'], 'unknown argument: debian'],
  ['a value on a flag', ['--stub=1'], 'unknown argument: --stub=1'],
  ['the option terminator', ['--stub', '--'], 'unknown argument: --'],
  ['an unknown flag before a missing image', ['--foo'], 'unknown argument: --foo'],
])('it refuses %s', (_label, argv, reason) => {
  expect(parseBootstrapArgs(argv)).toStrictEqual({ kind: 'refused', reason });
});
