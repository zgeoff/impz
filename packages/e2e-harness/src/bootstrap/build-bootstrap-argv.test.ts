import { expect, test } from 'bun:test';
import { buildBootstrapArgv } from './build-bootstrap-argv';

test('it skips the health check and passes the fake key file for the stand-in image', () => {
  expect(
    buildBootstrapArgv({
      mode: '--check',
      storage: ['--loop-file', '/var/imp.xfs', '--loop-size', '50'],
      extra: ['--ipv6', 'on'],
      image: 'imp-host-stub:test',
      health: false,
      stub: true,
    }),
  ).toStrictEqual([
    '--check',
    '--loop-file',
    '/var/imp.xfs',
    '--loop-size',
    '50',
    '--ipv6',
    'on',
    '--image',
    'imp-host-stub:test',
    '--image-archive',
    '/mnt/archive/image.tar',
    '--skip-health',
    '--tailscale-authkey-file',
    '/mnt/archive/authkey',
  ]);
});

test('it runs the health check and passes no key for a release image with --health', () => {
  expect(
    buildBootstrapArgv({
      mode: '--yes',
      storage: ['--data-device', '/dev/loop7'],
      extra: [],
      image: 'imp-host:1.2.3',
      health: true,
      stub: false,
    }),
  ).toStrictEqual([
    '--yes',
    '--data-device',
    '/dev/loop7',
    '--image',
    'imp-host:1.2.3',
    '--image-archive',
    '/mnt/archive/image.tar',
  ]);
});
