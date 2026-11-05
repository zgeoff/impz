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

test('it refuses a lane it has no images for, and runs no docker', async () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directoryPath, 'docker');

  const result = await ctx.runScript(stub.bin, 'browser');

  expect(result.exitCode).toBe(1);
  expect(readFileSync(stub.calls, 'utf8')).toBe('');
});
