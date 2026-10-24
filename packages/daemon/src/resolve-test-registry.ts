import type { BuilderTestRegistry } from './imps/images/builders/builder-imps';
import type { TestRegistryConfig } from './imps/imps-config';
import { getImpdLogger } from './platform/process/get-impd-logger';

export interface TestRegistryBoundaries {
  readonly readAddress: (name: string) => Promise<string>;
  readonly readCA: (path: string) => Promise<string>;
}

// The address comes from impd's own resolver, where the e2e host names the registry; a
// builder's resolver drops a private answer, so impd hands the builder this address.
export async function resolveTestRegistry(
  config: TestRegistryConfig | null,
  deps: Readonly<TestRegistryBoundaries>,
): Promise<BuilderTestRegistry | null> {
  if (config === null) {
    return null;
  }

  const address = await deps.readAddress(config.name);

  getImpdLogger('image').warning(
    'IMP_E2E=1 and IMP_BUILD_TEST_REGISTRY open {address}:{port} to builders, for {name}',
    { address, port: String(config.port), name: config.name },
  );

  return {
    name: config.name,
    address,
    port: config.port,
    readCA: () => deps.readCA(config.caPath),
  };
}
