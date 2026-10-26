import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPebbleNames, readPebbleEndpoints, startPebbleStack } from '@impz/daemon/testing';
import type { PebbleNames } from '@impz/daemon/testing';
import { REPO_ROOT, instance, runCommand } from './instance';

export const PEBBLE_DOMAIN = 'imp.test';

// Under .cache, which the dev container mounts at /src/.cache.
const HARNESS_MINICA_DIR = join(REPO_ROOT, '.cache', 'e2e');

// The stack outlives this process, so stopPebble removes it, not a disposable stack; the dev
// instance may still sit on the network, so the stack reuses it.
export async function startPebble(): Promise<void> {
  await stopHarnessStack(buildPebbleNames(instance.container, HARNESS_MINICA_DIR));

  await startPebbleStack({ defer: () => {} }, instance.container, {
    minicaDir: HARNESS_MINICA_DIR,
    reuseNetwork: true,
  });
}

async function stopHarnessStack(names: PebbleNames): Promise<void> {
  await runCommand(['docker', 'rm', '-f', names.pebble, names.challtestsrv]);
  await runCommand(['docker', 'network', 'rm', names.network]);
}

export function probePebbleRunning(): boolean {
  const names = buildPebbleNames(instance.container, HARNESS_MINICA_DIR);

  const inspect = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', names.pebble], {
    stdout: 'pipe',
    stderr: 'ignore',
  });

  return inspect.stdout.toString().trim() === 'true';
}

const PUBLIC_IP = '203.0.113.7';

export const PUBLIC_HTTPS_PORT = 7443;

export function buildPebbleEnv(
  container: string = instance.container,
): Readonly<Record<string, string>> {
  const names = buildPebbleNames(container, HARNESS_MINICA_DIR);

  return {
    IMP_DEV_NETWORK: names.network,
    IMP_E2E: '1',
    IMP_DOMAIN: PEBBLE_DOMAIN,
    IMP_DNS_PROVIDER: 'challtestsrv',
    IMP_DNS_API_URL: 'http://challtestsrv:8055',
    IMP_ACME_DIRECTORY: 'https://pebble:14000/dir',
    IMP_ACME_CA_FILE: names.minicaFile,

    // Public imps on TEST-NET-3: only the record points there, and the suite
    // reaches the public listener on loopback in the container.
    IMP_PUBLIC_IP: PUBLIC_IP,
  };
}

export function stopPebble(): Promise<void> {
  return stopHarnessStack(buildPebbleNames(instance.container, HARNESS_MINICA_DIR));
}

export async function writePebbleRoot(): Promise<string> {
  const endpoints = await readPebbleEndpoints(
    buildPebbleNames(instance.container, HARNESS_MINICA_DIR),
  );

  const response = await fetch(endpoints.rootUrl, { tls: { ca: endpoints.minicaPem } });
  const pem = await response.text();

  const path = join(HARNESS_MINICA_DIR, 'pebble-root.pem');

  writeFileSync(path, pem);

  return path;
}
