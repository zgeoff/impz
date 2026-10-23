import { expect, test } from 'bun:test';
import { instance } from './instance';
import { buildRegistryPlan, buildRegistrySettings } from './registry-plan';

test('#buildRegistryPlan puts the registry on a port of the instance, with certificates under the repo', () => {
  expect(
    buildRegistryPlan(
      { ...instance, container: 'imp-dev-wt', portOffset: 200 },
      'registry.e2e.test',
      '/work/impz',
    ),
  ).toStrictEqual({
    name: 'registry.e2e.test',
    port: 15_643,
    certDirectory: '/work/impz/.cache/e2e/imp-dev-wt-registry-tls',
  });
});

test('#buildRegistrySettings opens the registry to builders on an e2e impd, with its CA', () => {
  expect(
    buildRegistrySettings({
      name: 'registry.e2e.test',
      port: 15_643,
      certDirectory: '/work/impz/.cache/e2e/imp-dev-wt-registry-tls',
    }),
  ).toStrictEqual({
    IMP_E2E: '1',
    IMP_BUILD_TEST_REGISTRY: 'registry.e2e.test:15643',
    IMP_BUILD_TEST_REGISTRY_CA: '/work/impz/.cache/e2e/imp-dev-wt-registry-tls/cert.pem',
  });
});
