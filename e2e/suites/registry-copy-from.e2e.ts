import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../lib/config';
import { createRegistryTrust } from '../lib/create-registry-trust';
import { createInstanceClient, runInImp } from '../lib/imp-cli';
import { REPO_ROOT, instance } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { buildRegistryPlan } from '../lib/registry-plan';
import {
  checkRegistryReady,
  collectUnpinnedRequests,
  createImageImp,
  createMovedTag,
  readBusyboxDigest,
  removeStaleRegistries,
  runBuildAndListRequests,
  startRegistry,
} from '../lib/registry-steps';
import { removeImageIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';

// collection-time gate: Bun 1.4.2's skipIf takes a boolean and has no in-body skip
const isReady = await checkRegistryReady(config.registryName);

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
  'it uses the content impd pinned for COPY --from and RUN --mount from= a moved tag, fetched by digest after the pin',
  async () => {
    const ctx = await setupTest();

    const copied = `${ctx.prefix}copied`;
    const repository = 'e2e/source';

    const busybox = await readBusyboxDigest();
    const moved = await createMovedTag(ctx.stack, ctx.registry, ctx.directoryPath, repository);

    const dockerfile = [
      `FROM ${busybox}`,
      `COPY --from=${moved.tag} /v /copied`,
      `RUN --mount=from=${moved.tag},target=/m cp /m/v /mounted`,
      '',
    ].join('\n');

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, copied));

    const seen = await runBuildAndListRequests({
      registry: ctx.registry,
      directory: ctx.directoryPath,
      repository,
      dockerfile,
      name: copied,
    });

    await createImageImp(ctx.stack, ctx.client, copied);

    const fromCopy = await runInImp(copied, 'cat', '/copied');
    const fromMount = await runInImp(copied, 'cat', '/mounted');

    expect(collectUnpinnedRequests(moved.current, seen)).toStrictEqual(['1']);
    expect(fromCopy).toBe('new');
    expect(fromMount).toBe('new');
  },
);
