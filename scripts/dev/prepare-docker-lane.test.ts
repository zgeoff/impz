import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StubBin } from '@impz/shared/test-utils/create-stub-bin';
import { createStubAnsweringBin } from '../test-utils/create-stub-answering-bin';
import prepareDockerLane from './prepare-docker-lane';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-prepare-docker-lane-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    prepareLane: (docker: StubBin, lane: string) => {
      prepareDockerLane({
        repoRoot: directory,
        lane: {
          name: lane,
          suffix: `.${lane}`,
          limitMs: 5000,
          parallel: 1,
          memory: null,
          start: 'scripts/dev/prepare-docker-lane.ts',
          stop: null,
        },
        runID: '4242',
        environment: { ...process.env, PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
      });
    },
  };
}

test('it pulls each image of the lane, then starts one container of each on a network it removes', () => {
  const ctx = setupTest();
  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', []);

  ctx.prepareLane(docker, 'headscale');

  expect(readFileSync(docker.calls, 'utf8').split('\n')).toStrictEqual([
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

  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['pull'], exitCode: 1, stderr: 'toomanyrequests: rate limit' },
  ]);

  expect(() => {
    ctx.prepareLane(docker, 'pebble');
  }).toThrow(/^docker pull --quiet ghcr\.io\/letsencrypt\/pebble:\S+ exited 1$/v);

  expect(readFileSync(docker.calls, 'utf8').split('\n')).toStrictEqual([
    expect.stringMatching(/^docker pull --quiet ghcr\.io\/letsencrypt\/pebble:/v),
    '',
  ]);
});

test('it fails, and creates no container, when the network will not create', () => {
  const ctx = setupTest();

  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['network', 'create'], exitCode: 1, stderr: 'pool overlaps' },
  ]);

  expect(() => {
    ctx.prepareLane(docker, 'pebble');
  }).toThrow('docker network create imp-pebble-lane-warm-up-4242 exited 1');

  expect(readFileSync(docker.calls, 'utf8').split('\n').slice(-2)).toStrictEqual([
    'docker network create imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it removes its containers and network, and fails, when a container will not create', () => {
  const ctx = setupTest();

  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['create'], exitCode: 1, stderr: 'no such image' },
  ]);

  expect(() => {
    ctx.prepareLane(docker, 'pebble');
  }).toThrow(/^docker create --name imp-pebble-lane-warm-up-4242-pebble .+ exited 1$/v);

  expect(readFileSync(docker.calls, 'utf8').split('\n').slice(-4)).toStrictEqual([
    expect.stringMatching(/^docker create --name imp-pebble-lane-warm-up-4242-pebble /v),
    'docker rm --force imp-pebble-lane-warm-up-4242-pebble imp-pebble-lane-warm-up-4242-challtestsrv',
    'docker network rm imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it removes its containers and network when a container will not start', () => {
  const ctx = setupTest();

  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['start'], exitCode: 1 },
  ]);

  expect(() => {
    ctx.prepareLane(docker, 'pebble');
  }).toThrow('docker start imp-pebble-lane-warm-up-4242-pebble exited 1');

  expect(readFileSync(docker.calls, 'utf8').split('\n').slice(-3)).toStrictEqual([
    'docker rm --force imp-pebble-lane-warm-up-4242-pebble imp-pebble-lane-warm-up-4242-challtestsrv',
    'docker network rm imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it still removes its network, and fails, when removing its containers fails', () => {
  const ctx = setupTest();

  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['rm'], exitCode: 1, stderr: 'cannot remove a container: device busy' },
  ]);

  expect(() => {
    ctx.prepareLane(docker, 'pebble');
  }).toThrow(
    'docker rm --force imp-pebble-lane-warm-up-4242-pebble imp-pebble-lane-warm-up-4242-challtestsrv exited 1',
  );

  expect(readFileSync(docker.calls, 'utf8').split('\n').slice(-2)).toStrictEqual([
    'docker network rm imp-pebble-lane-warm-up-4242',
    '',
  ]);
});

test('it fails when removing its network fails, after it removed its containers', () => {
  const ctx = setupTest();

  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['network', 'rm'], exitCode: 1 },
  ]);

  expect(() => {
    ctx.prepareLane(docker, 'pebble');
  }).toThrow('docker network rm imp-pebble-lane-warm-up-4242 exited 1');
});

test('it refuses a lane it has no images for, and runs no docker', () => {
  const ctx = setupTest();
  const docker = createStubAnsweringBin(ctx.directoryPath, 'docker', []);

  expect(() => {
    ctx.prepareLane(docker, 'browser');
  }).toThrow();

  expect(readFileSync(docker.calls, 'utf8').split('\n')).toStrictEqual(['']);
});
