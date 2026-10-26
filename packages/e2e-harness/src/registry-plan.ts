import { join } from 'node:path';
import type { DevInstance } from './instance';

export interface RegistryPlan {
  readonly name: string;
  readonly port: number;

  // Under the repo: dev.sh mounts it at its /src path, where impd reads the CA.
  readonly certDirectory: string;

  // A builder's own engine holds Docker's default bridge range, so the registry
  // listens on the gateway of a network outside it.
  readonly network: string;
  readonly subnet: string;
  readonly gateway: string;
}

const REGISTRY_PORT_BASE = 15_443;

export function buildRegistryPlan(
  target: Readonly<DevInstance>,
  name: string,
  repoRoot: string,
): RegistryPlan {
  const offset = target.portOffset;
  const second = 200 + Math.floor(offset / 256);

  if (!Number.isInteger(offset) || offset < 0 || second > 255) {
    throw new Error(`no registry network for port offset ${String(offset)}`);
  }

  const base = `10.${String(second)}.${String(offset % 256)}`;

  return {
    name,
    port: REGISTRY_PORT_BASE + offset,
    certDirectory: join(repoRoot, '.cache', 'e2e', `${target.container}-registry-tls`),
    network: `${target.container}-registry`,
    subnet: `${base}.0/24`,
    gateway: `${base}.1`,
  };
}

export function buildRegistrySettings(plan: Readonly<RegistryPlan>): Record<string, string> {
  return {
    IMP_E2E: '1',
    IMP_BUILD_TEST_REGISTRY: `${plan.name}:${String(plan.port)}`,
    IMP_BUILD_TEST_REGISTRY_CA: join(plan.certDirectory, 'cert.pem'),
  };
}
