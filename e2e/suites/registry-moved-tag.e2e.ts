import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@impz/e2e-harness/config';
import { createRegistryTrust } from '@impz/e2e-harness/create-registry-trust';
import { createInstanceClient, runInImp } from '@impz/e2e-harness/imp-cli';
import { REPO_ROOT, instance } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { buildRegistryPlan } from '@impz/e2e-harness/registry-plan';
import {
  checkRegistryReady,
  collectUnpinnedRequests,
  createImageImp,
  createMovedTag,
  getDigest,
  removeStaleRegistries,
  runBuildAndListRequests,
  startRegistry,
} from '@impz/e2e-harness/registry-steps';
import { removeImageIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

// collection-time gate: Bun's skipIf takes a boolean and has no in-body skip
const isReady = await checkRegistryReady(
  buildRegistryPlan(instance, config.registryName, REPO_ROOT),
);

const registryMissing = !isReady;

// One stack for every release, so the trust goes before its registry.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const prefix = getSuitePrefix('registry');

  // Under the repo: dev.sh mounts it at the same path in the container.
  const directory = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'registry-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  await removeStaleRegistries(prefix);

  const container = `${prefix}registry-${String(process.pid)}`;

  const registry = await startRegistry(
    stack,
    buildRegistryPlan(instance, config.registryName, REPO_ROOT),
    container,
  );

  // The engine reads certs.d on each request, so it needs no restart.
  const trust = await createRegistryTrust({
    registry: registry.address,
    certPath: registry.certPath,
  });

  stack.defer(() => trust.remove());

  return {
    prefix,
    stack,
    directoryPath: directory,
    registry,
    client: await createInstanceClient(),
  };
}

test.skipIf(registryMissing)(
  'it builds a tag the registry moved from the content it serves, not the host’s older copy, and fetches it by digest after the pin',
  async () => {
    const ctx = await setupTest();

    const mutable = `${ctx.prefix}mutable`;
    const repository = 'e2e/mutable';

    const moved = await createMovedTag(ctx.stack, ctx.registry, ctx.directoryPath, repository);

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, mutable));

    const seen = await runBuildAndListRequests({
      registry: ctx.registry,
      directory: ctx.directoryPath,
      repository,
      dockerfile: `FROM ${moved.tag}\nRUN cat /v\n`,
      name: mutable,
    });

    await createImageImp(ctx.stack, ctx.client, mutable);

    const content = await runInImp(mutable, 'cat', '/v');

    expect(collectUnpinnedRequests(moved.current, seen)).toStrictEqual(['1']);
    expect(seen).toContain(getDigest(moved.current));
    expect(content).toBe('new');
  },
);
