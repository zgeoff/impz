import { expect, test } from 'bun:test';
import { pickLogCollection } from './pick-log-collection';

test('it reads a Docker container as the runner, and shows the data disk and the free space', () => {
  expect(
    pickLogCollection({
      engine: 'docker',
      container: 'imp-dev',
      owner: '1001:118',
      logsDir: '.cache/e2e',
      zfsDir: null,
      dataDir: '/mnt/imp-e2e',
      zfsDirFiles: [],
    }),
  ).toStrictEqual({
    prepareCommands: [],
    copies: [],
    logsCommand: ['docker', 'logs', 'imp-dev'],
    diskCommands: [
      ['du', '-h', '/mnt/imp-e2e/imp.xfs'],
      ['df', '-h', '/', '/mnt'],
    ],
  });
});

test('it takes back the logs folder and reads a Podman container as root', () => {
  expect(
    pickLogCollection({
      engine: 'podman',
      container: 'imp-dev',
      owner: '1001:118',
      logsDir: '.cache/e2e',
      zfsDir: null,
      dataDir: null,
      zfsDirFiles: [],
    }),
  ).toStrictEqual({
    prepareCommands: [
      ['sudo', 'mkdir', '-p', '.cache/e2e'],
      ['sudo', 'chown', '-R', '1001:118', '.cache/e2e'],
    ],
    copies: [],
    logsCommand: ['sudo', 'podman', 'logs', 'imp-dev'],
    diskCommands: [['df', '-h', '/', '/mnt']],
  });
});

test("it copies only the zfs host test's files that its work dir holds", () => {
  expect(
    pickLogCollection({
      engine: 'docker',
      container: 'imp-zfs',
      owner: '1001:118',
      logsDir: '.cache/e2e',
      zfsDir: '/runner/imp-zfs',
      dataDir: null,
      zfsDirFiles: ['impd.log', 'pool.img', 'summary.txt'],
    }).copies,
  ).toStrictEqual([
    { from: '/runner/imp-zfs/impd.log', to: '.cache/e2e/impd.log' },
    { from: '/runner/imp-zfs/summary.txt', to: '.cache/e2e/summary.txt' },
  ]);
});
