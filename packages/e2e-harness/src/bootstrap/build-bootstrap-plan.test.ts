import { expect, test } from 'bun:test';
import { buildBootstrapPlan } from './build-bootstrap-plan';

test('it runs each distro, the data-device leg after Debian, then the zfs leg', () => {
  expect(
    buildBootstrapPlan({
      image: null,
      stub: true,
      health: false,
      keep: false,
      zfs: true,
      distros: ['debian', 'ubuntu24', 'ubuntu26'],
    }),
  ).toStrictEqual([
    { kind: 'distro', distro: 'debian' },
    { kind: 'device' },
    { kind: 'distro', distro: 'ubuntu24' },
    { kind: 'distro', distro: 'ubuntu26' },
    { kind: 'zfs' },
  ]);
});

test('it runs no zfs leg without --zfs', () => {
  expect(
    buildBootstrapPlan({
      image: 'imp-host:1.2.3',
      stub: false,
      health: true,
      keep: false,
      zfs: false,
      distros: ['debian'],
    }),
  ).toStrictEqual([{ kind: 'distro', distro: 'debian' }, { kind: 'device' }]);
});

test('it runs no data-device leg for an Ubuntu distro alone', () => {
  expect(
    buildBootstrapPlan({
      image: null,
      stub: true,
      health: false,
      keep: false,
      zfs: true,
      distros: ['ubuntu26'],
    }),
  ).toStrictEqual([{ kind: 'distro', distro: 'ubuntu26' }, { kind: 'zfs' }]);
});
