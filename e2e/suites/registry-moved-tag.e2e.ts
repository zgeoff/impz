import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../lib/config';
import { createRegistryTrust } from '../lib/create-registry-trust';
import { createInstanceClient } from '../lib/imp-cli';
import { REPO_ROOT } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import {
  checkRegistryReady,
  collectUnpinnedRequests,
  createMovedTag,
  readFileInImage,
  removeStaleRegistries,
  runBuildAndListRequests,
  startRegistry,
} from '../lib/registry-steps';
import { removeImageIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';

// #145: impd builds each image by the digest it inspected. A registry the
// journey owns proves it (lib/registry-steps.ts), on the suite's
// IMP_BUILD_ISOLATION=host.

// collection-time gate: Bun 1.4.2's skipIf takes a boolean and has no in-body skip
const isReady = await checkRegistryReady(config.registryName);

const registryMissing = !isReady;

// one stack for every release: the trust goes before its registry
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const prefix = getSuitePrefix('registry');

  // under the repo: scripts/dev/dev.sh mounts it at the same path in the container
  const directory = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'registry-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  await removeStaleRegistries(prefix);

  const container = `${prefix}registry-${String(process.pid)}`;

  const registry = await startRegistry(stack, config.registryName, container, directory);

  // the engine reads certs.d on each request: no restart
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
  'it builds the content impd inspected from a tag the registry moved after the host pulled it',
  async () => {
    const ctx = await setupTest();

    const mutable = `${ctx.prefix}mutable`;
    const repository = 'e2e/mutable';

    const moved = await createMovedTag(ctx.stack, ctx.registry, ctx.directoryPath, repository);

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, mutable));

    const seen = await runBuildAndListRequests(
      ctx.registry,
      ctx.directoryPath,
      repository,
      `FROM ${moved.tag}\nRUN cat /v\n`,
      mutable,
    );

    const content = await readFileInImage(mutable, '/v');

    expect(collectUnpinnedRequests(moved.pinned, seen)).toStrictEqual([]);
    expect(content).toBe('old');
  },
);
