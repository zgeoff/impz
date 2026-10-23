import { join } from 'node:path';
import type { DevInstance } from './instance';

export interface RegistryPlan {
  readonly name: string;
  readonly port: number;

  // Under the repo: dev.sh mounts it at its /src path, where impd reads the CA.
  readonly certDirectory: string;
}

const REGISTRY_PORT_BASE = 15_443;

export function buildRegistryPlan(
  target: Readonly<DevInstance>,
  name: string,
  repoRoot: string,
): RegistryPlan {
  return {
    name,
    port: REGISTRY_PORT_BASE + target.portOffset,
    certDirectory: join(repoRoot, '.cache', 'e2e', `${target.container}-registry-tls`),
  };
}

export function buildRegistrySettings(plan: Readonly<RegistryPlan>): Record<string, string> {
  return {
    IMP_E2E: '1',
    IMP_BUILD_TEST_REGISTRY: `${plan.name}:${String(plan.port)}`,
    IMP_BUILD_TEST_REGISTRY_CA: join(plan.certDirectory, 'cert.pem'),
  };
}
