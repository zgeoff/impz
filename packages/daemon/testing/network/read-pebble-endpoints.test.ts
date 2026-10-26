import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { updateEnv } from '@impz/test-utils/update-env';
import { buildPebbleNames } from './build-pebble-names';
import { parsePublishedPort, readPebbleEndpoints } from './read-pebble-endpoints';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'pebble-endpoints-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('#readPebbleEndpoints reads each published port and the minica PEM of a running stack', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$*" in',
      '  "port imp-acme-it-x-pebble 14000/tcp") echo 127.0.0.1:49153 ;;',
      '  "port imp-acme-it-x-pebble 15000/tcp") echo 127.0.0.1:49154 ;;',
      '  "port imp-acme-it-x-challtestsrv 8055/tcp") echo 127.0.0.1:49155 ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await writeFile(join(ctx.directoryPath, 'imp-acme-it-x-pebble-minica.pem'), 'minica pem\n');

  const endpoints = await readPebbleEndpoints(buildPebbleNames('imp-acme-it-x', ctx.directoryPath));

  expect(endpoints).toStrictEqual({
    directoryUrl: 'https://localhost:49153/dir',
    rootUrl: 'https://localhost:49154/roots/0',
    challtestsrvUrl: 'http://127.0.0.1:49155',
    minicaFile: join(ctx.directoryPath, 'imp-acme-it-x-pebble-minica.pem'),
    minicaPem: 'minica pem\n',
  });
});

test('#parsePublishedPort reads the host port of a loopback binding', () => {
  expect(parsePublishedPort('acme-pebble', 14_000, '127.0.0.1:49153\n')).toBe('49153');
});

test('#parsePublishedPort reads the first binding’s port when there are several', () => {
  expect(parsePublishedPort('acme-pebble', 14_000, '0.0.0.0:49153\n[::]:49154\n')).toBe('49153');
});

test('#parsePublishedPort refuses output that names no port, with the container and port', () => {
  expect(() => parsePublishedPort('acme-pebble', 14_000, '\n')).toThrowWithMessage(
    Error,
    'acme-pebble publishes no port for 14000: ',
  );
});
