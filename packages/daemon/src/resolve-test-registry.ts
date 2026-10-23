import { lookup } from 'node:dns/promises';
import type { BuilderTestRegistry } from './imps/images/builder-imps';
import type { TestRegistryConfig } from './imps/imps-config';

// The address comes from impd's own resolver, where the e2e host names the registry; a
// builder's resolver drops a private answer, so impd hands the builder this address.
export async function resolveTestRegistry(
  config: TestRegistryConfig | null,
  log: (message: string) => void,
): Promise<BuilderTestRegistry | null> {
  if (config === null) {
    return null;
  }

  const resolved = await lookup(config.name, { family: 4 });

  log(
    `impd: warning: IMP_E2E=1 and IMP_BUILD_TEST_REGISTRY open ${resolved.address}:${String(config.port)} to builders, for ${config.name}`,
  );

  return {
    name: config.name,
    address: resolved.address,
    port: config.port,
    caPath: config.caPath,
  };
}
