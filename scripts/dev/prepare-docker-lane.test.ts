import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-prepare-docker-lane-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    runScript: (bin: string, lane: string) =>
      $`${process.execPath} ${join(import.meta.dir, 'prepare-docker-lane.ts')} ${lane}`
        .env({ ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` })
        .nothrow()
        .quiet(),
    readCalls: (calls: string) =>
      readFileSync(calls, 'utf8')
        .replaceAll(/warm-up-\d+/gv, 'warm-up-<pid>')
        .split('\n'),
  };
}

test('it pulls each image of the lane, then starts one container of each on a network it removes', async () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directoryPath, 'docker');

  const result = await ctx.runScript(stub.bin, 'headscale');

  expect(result.exitCode).toBe(0);

  expect(ctx.readCalls(stub.calls)).toStrictEqual([
    expect.stringMatching(/^docker pull --quiet headscale\/headscale:/v),
    expect.stringMatching(/^docker pull --quiet tailscale\/tailscale:/v),
    'docker network create imp-headscale-lane-warm-up-<pid>',
    expect.stringMatching(
      /^docker create --name imp-headscale-lane-warm-up-<pid>-headscale --network imp-headscale-lane-warm-up-<pid> -p 127\.0\.0\.1::80 headscale\/headscale:/v,
    ),
    'docker start imp-headscale-lane-warm-up-<pid>-headscale',
    expect.stringMatching(
      /^docker create --name imp-headscale-lane-warm-up-<pid>-tailscale --network imp-headscale-lane-warm-up-<pid> -p 127\.0\.0\.1::80 tailscale\/tailscale:/v,
    ),
    'docker start imp-headscale-lane-warm-up-<pid>-tailscale',
    'docker rm --force imp-headscale-lane-warm-up-<pid>-headscale imp-headscale-lane-warm-up-<pid>-tailscale',
    'docker network rm imp-headscale-lane-warm-up-<pid>',
    '',
  ]);
});

test('it fails, and makes nothing, when a pull fails', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'docker',
    '[ "$1" = pull ] && { echo "toomanyrequests: rate limit" >&2; exit 1; }\nexit 0',
  );

  const result = await ctx.runScript(stub.bin, 'pebble');

  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    calls: ctx.readCalls(stub.calls),
  }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining('toomanyrequests: rate limit'),
    calls: [expect.stringMatching(/^docker pull --quiet ghcr\.io\/letsencrypt\/pebble:/v), ''],
  });
});

test('it fails, and creates no container, when the network will not create', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'docker',
    '[ "$1" = network ] && [ "$2" = create ] && { echo "pool overlaps" >&2; exit 1; }\nexit 0',
  );

  const result = await ctx.runScript(stub.bin, 'pebble');

  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    lastCalls: ctx.readCalls(stub.calls).slice(-2),
  }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining('pool overlaps'),
    lastCalls: ['docker network create imp-pebble-lane-warm-up-<pid>', ''],
  });
});

test('it removes its containers and network, and fails, when a container will not create', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'docker',
    '[ "$1" = create ] && { echo "no such image" >&2; exit 1; }\nexit 0',
  );

  const result = await ctx.runScript(stub.bin, 'pebble');

  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    lastCalls: ctx.readCalls(stub.calls).slice(-4),
  }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining('no such image'),
    lastCalls: [
      expect.stringMatching(/^docker create --name imp-pebble-lane-warm-up-<pid>-pebble /v),
      'docker rm --force imp-pebble-lane-warm-up-<pid>-pebble imp-pebble-lane-warm-up-<pid>-challtestsrv',
      'docker network rm imp-pebble-lane-warm-up-<pid>',
      '',
    ],
  });
});

test('it removes its containers and network when a container will not start', async () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directoryPath, 'docker', '[ "$1" = start ] && exit 1\nexit 0');

  const result = await ctx.runScript(stub.bin, 'pebble');

  expect(result.exitCode).toBe(1);

  expect(ctx.readCalls(stub.calls).slice(-3)).toStrictEqual([
    'docker rm --force imp-pebble-lane-warm-up-<pid>-pebble imp-pebble-lane-warm-up-<pid>-challtestsrv',
    'docker network rm imp-pebble-lane-warm-up-<pid>',
    '',
  ]);
});

test('it still removes its network, and fails, when removing its containers fails', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'docker',
    '[ "$1" = rm ] && { echo "cannot remove a container: device busy" >&2; exit 1; }\nexit 0',
  );

  const result = await ctx.runScript(stub.bin, 'pebble');

  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    lastCalls: ctx.readCalls(stub.calls).slice(-2),
  }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining('docker rm --force imp-pebble-lane-warm-up-'),
    lastCalls: ['docker network rm imp-pebble-lane-warm-up-<pid>', ''],
  });
});

test('it fails when removing its network fails, after it removed its containers', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'docker',
    '[ "$1" = network ] && [ "$2" = rm ] && exit 1\nexit 0',
  );

  const result = await ctx.runScript(stub.bin, 'pebble');

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining('docker network rm imp-pebble-lane-warm-up-'),
  });
});

test('it refuses a lane it has no images for, and runs no docker', async () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directoryPath, 'docker');

  const result = await ctx.runScript(stub.bin, 'browser');

  expect(result.exitCode).toBe(1);
  expect(readFileSync(stub.calls, 'utf8')).toBe('');
});
