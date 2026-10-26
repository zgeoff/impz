import { expect, test } from 'bun:test';
import { instance } from './instance';
import { buildRegistryPlan, buildRegistrySettings } from './registry-plan';

test('#buildRegistryPlan puts the registry on a port and a network of the instance, with certificates under the repo', () => {
  expect(
    buildRegistryPlan(
      { ...instance, container: 'imp-dev-wt', portOffset: 300 },
      'registry.e2e.test',
      '/work/impz',
    ),
  ).toStrictEqual({
    name: 'registry.e2e.test',
    port: 15_743,
    certDirectory: '/work/impz/.cache/e2e/imp-dev-wt-registry-tls',
    network: 'imp-dev-wt-registry',
    subnet: '10.201.44.0/24',
    gateway: '10.201.44.1',
  });
});

test('#buildRegistryPlan refuses a port offset past the last registry network', () => {
  expect(() =>
    buildRegistryPlan(
      { ...instance, container: 'imp-dev-wt', portOffset: 14_336 },
      'registry.e2e.test',
      '/work/impz',
    ),
  ).toThrowWithMessage(Error, 'no registry network for port offset 14336');
});

test('#buildRegistrySettings opens the registry to builders on an e2e impd, with its CA', () => {
  expect(
    buildRegistrySettings({
      name: 'registry.e2e.test',
      port: 15_643,
      certDirectory: '/work/impz/.cache/e2e/imp-dev-wt-registry-tls',
      network: 'imp-dev-wt-registry',
      subnet: '10.200.200.0/24',
      gateway: '10.200.200.1',
    }),
  ).toStrictEqual({
    IMP_E2E: '1',
    IMP_BUILD_TEST_REGISTRY: 'registry.e2e.test:15643',
    IMP_BUILD_TEST_REGISTRY_CA: '/work/impz/.cache/e2e/imp-dev-wt-registry-tls/cert.pem',
  });
});
