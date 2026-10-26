import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildPebbleNames } from './build-pebble-names';
import type { PebbleNames } from './build-pebble-names';
import { PEBBLE_IMAGES } from './pebble-images';
import { readPebbleEndpoints } from './read-pebble-endpoints';
import type { PebbleEndpoints } from './read-pebble-endpoints';
import { runDocker } from './run-docker';

export async function startPebbleStack(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  prefix: string,
  options: Readonly<{ minicaDir: string; reuseNetwork?: boolean }>,
): Promise<PebbleEndpoints> {
  const names = buildPebbleNames(prefix, options.minicaDir);
  const started = performance.now();

  const isPebbleTaken = await probeDockerObject(['container', 'inspect', names.pebble]);
  const isChallTestSrvTaken = await probeDockerObject(['container', 'inspect', names.challtestsrv]);
  const isNetworkTaken = await probeDockerObject(['network', 'inspect', names.network]);

  if (isPebbleTaken) {
    throw new Error(`a container named ${names.pebble} is already there`);
  }

  if (isChallTestSrvTaken) {
    throw new Error(`a container named ${names.challtestsrv} is already there`);
  }

  if (isNetworkTaken && options.reuseNetwork !== true) {
    throw new Error(`a network named ${names.network} is already there`);
  }

  if (!isNetworkTaken) {
    await runDocker(['network', 'create', names.network]);

    stack.defer(async () => {
      await runDocker(['network', 'rm', names.network]);
    });
  }

  // Created, then started, so a container that will not start still goes.
  await createChallTestSrv(names);

  stack.defer(async () => {
    await runDocker(['rm', '--force', names.challtestsrv]);
  });

  await runDocker(['start', names.challtestsrv]);
  await createPebble(names);

  stack.defer(async () => {
    await runDocker(['rm', '--force', names.pebble]);
  });

  await runDocker(['start', names.pebble]);

  return waitForStack(names, started);
}

async function probeDockerObject(args: readonly string[]): Promise<boolean> {
  const subprocess = Bun.spawn(['docker', ...args], {
    env: process.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return (await subprocess.exited) === 0;
}

function createChallTestSrv(names: PebbleNames): Promise<string> {
  return runDocker([
    'create',
    '--rm',
    '--name',
    names.challtestsrv,
    '--network',
    names.network,
    '--network-alias',
    'challtestsrv',
    '-p',
    '127.0.0.1::8055',
    PEBBLE_IMAGES.challtestsrv,
    '-defaultIPv6',
    '',
    '-defaultIPv4',
    '127.0.0.1',
  ]);
}

// No sleep before validation and no nonce rejections: a faster test, the
// same protocol.
function createPebble(names: PebbleNames): Promise<string> {
  return runDocker([
    'create',
    '--rm',
    '--name',
    names.pebble,
    '--network',
    names.network,
    '--network-alias',
    'pebble',
    '-e',
    'PEBBLE_VA_NOSLEEP=1',
    '-e',
    'PEBBLE_WFE_NONCEREJECT=0',
    '-p',
    '127.0.0.1::14000',
    '-p',
    '127.0.0.1::15000',
    PEBBLE_IMAGES.pebble,
    '-dnsserver',
    'challtestsrv:8053',
  ]);
}

async function waitForStack(names: PebbleNames, started: number): Promise<PebbleEndpoints> {
  const timings: string[] = [];

  const writePhaseTiming = (phase: string): void => {
    const elapsedMs = Math.round(performance.now() - started);

    timings.push(`${phase} ${String(elapsedMs)} ms`);
  };

  mkdirSync(dirname(names.minicaFile), { recursive: true });

  await runDocker(['cp', `${names.pebble}:/test/certs/pebble.minica.pem`, names.minicaFile]);

  writePhaseTiming('containers started');

  const endpoints = await readPebbleEndpoints(names);

  await waitFor(
    async () => {
      const response = await fetch(endpoints.directoryUrl, {
        tls: { ca: endpoints.minicaPem },
        signal: AbortSignal.timeout(1000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
    },
    { label: 'Pebble to answer', intervalMs: 50, timeoutMs: 60_000 },
  );

  writePhaseTiming('Pebble ready');

  // An issuance sets its TXT record through this API first, so a call that
  // reaches the published port before challtestsrv listens stalls or fails.
  await waitFor(
    async () => {
      const response = await fetch(new URL('/clear-txt', endpoints.challtestsrvUrl), {
        method: 'POST',
        body: JSON.stringify({ host: 'startup-probe.invalid.' }),
        signal: AbortSignal.timeout(1000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
    },
    { label: 'challtestsrv to answer', intervalMs: 50, timeoutMs: 60_000 },
  );

  writePhaseTiming('challtestsrv ready');

  console.error(`pebble ${names.prefix}: ${timings.join(', ')}`);

  return endpoints;
}
