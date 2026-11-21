import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import prepareDockerLane from './prepare-docker-lane';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-prepare-docker-lane-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    prepareLane: (lane: string) => {
      prepareDockerLane({
        repoRoot: directory,
        lane: {
          name: lane,
          suffix: `.${lane}`,
          limitMs: 5000,
          parallel: 1,
          memory: null,
          start: 'packages/daemon/src/test-utils/prepare-docker-lane.ts',
          stop: null,
        },
        runID: '4242',
        environment: { ...process.env, PATH: `${directory}:${process.env['PATH'] ?? ''}` },
      });
    },
  };
}

test('it pulls each image of the lane, then starts one container of each on a network it removes', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker');

  ctx.prepareLane('headscale');

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    expect.stringMatching(/^docker pull --quiet headscale\/headscale:/v),
    expect.stringMatching(/^docker pull --quiet tailscale\/tailscale:/v),
    'docker network create imp-headscale-lane-warm-up-4242',
    expect.stringMatching(
      /^docker create --name imp-headscale-lane-warm-up-4242-headscale --network imp-headscale-lane-warm-up-4242 -p 127\.0\.0\.1::80 headscale\/headscale:/v,
    ),
    'docker start imp-headscale-lane-warm-up-4242-headscale',
    expect.stringMatching(
      /^docker create --name imp-headscale-lane-warm-up-4242-tailscale --network imp-headscale-lane-warm-up-4242 -p 127\.0\.0\.1::80 tailscale\/tailscale:/v,
    ),
    'docker start imp-headscale-lane-warm-up-4242-tailscale',
    'docker rm --force imp-headscale-lane-warm-up-4242-headscale imp-headscale-lane-warm-up-4242-tailscale',
    'docker network rm imp-headscale-lane-warm-up-4242',
    '',
  ]);
});

test('it fails, and makes nothing, when a pull fails', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    answers: [{ args: ['pull'], exitCode: 1, stderr: 'toomanyrequests: rate limit' }, { args: [] }],
  });

  expect(() => {
    ctx.prepareLane('pebble');
  }).toThrow(/^docker pull --quiet ghcr\.io\/letsencrypt\/pebble:\S+ exited 1$/v);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    expect.stringMatching(/^docker pull --quiet ghcr\.io\/letsencrypt\/pebble:/v),
    '',
  ]);
});

test('it fails, and creates no container, when the network will not create', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    answers: [{ args: ['network', 'create'], exitCode: 1, stderr: 'pool overlaps' }, { args: [] }],
  });

  expect(() => {
    ctx.prepareLane('pebble');
  }).toThrow('docker network create imp-pebble-lane-warm-up-4242 exited 1');

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n').slice(-2)).toStrictEqual([
    'docker network create imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it removes its containers and network, and fails, when a container will not create', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    answers: [{ args: ['create'], exitCode: 1, stderr: 'no such image' }, { args: [] }],
  });

  expect(() => {
    ctx.prepareLane('pebble');
  }).toThrow(/^docker create --name imp-pebble-lane-warm-up-4242-pebble .+ exited 1$/v);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n').slice(-4)).toStrictEqual([
    expect.stringMatching(/^docker create --name imp-pebble-lane-warm-up-4242-pebble /v),
    'docker rm --force imp-pebble-lane-warm-up-4242-pebble imp-pebble-lane-warm-up-4242-challtestsrv',
    'docker network rm imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it removes its containers and network when a container will not start', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    answers: [{ args: ['start'], exitCode: 1 }, { args: [] }],
  });

  expect(() => {
    ctx.prepareLane('pebble');
  }).toThrow('docker start imp-pebble-lane-warm-up-4242-pebble exited 1');

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n').slice(-3)).toStrictEqual([
    'docker rm --force imp-pebble-lane-warm-up-4242-pebble imp-pebble-lane-warm-up-4242-challtestsrv',
    'docker network rm imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it still removes its network, and fails, when removing its containers fails', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    answers: [
      { args: ['rm'], exitCode: 1, stderr: 'cannot remove a container: device busy' },
      { args: [] },
    ],
  });

  expect(() => {
    ctx.prepareLane('pebble');
  }).toThrow(
    'docker rm --force imp-pebble-lane-warm-up-4242-pebble imp-pebble-lane-warm-up-4242-challtestsrv exited 1',
  );

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n').slice(-2)).toStrictEqual([
    'docker network rm imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it fails when removing its network fails, after it removed its containers', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    answers: [{ args: ['network', 'rm'], exitCode: 1 }, { args: [] }],
  });

  expect(() => {
    ctx.prepareLane('pebble');
  }).toThrow('docker network rm imp-pebble-lane-warm-up-4242 exited 1');
});

test('it refuses a lane it has no images for, and runs no docker', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker');

  expect(() => {
    ctx.prepareLane('browser');
  }).toThrow();

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual(['']);
});
