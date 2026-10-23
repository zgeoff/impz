import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../lib/config';
import { createRegistryTrust } from '../lib/create-registry-trust';
import { createInstanceClient, runImp, runInImp } from '../lib/imp-cli';
import { REPO_ROOT, instance, runChecked, runCommand } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { writeRegistryIndex } from '../lib/registry-index';
import { buildRegistryPlan } from '../lib/registry-plan';
import {
  checkRegistryReady,
  createImageImp,
  createPushedImage,
  listManifestRequests,
  readBusyboxDigest,
  readHostArch,
  removeStaleRegistries,
  startRegistry,
  writeContext,
} from '../lib/registry-steps';
import { removeImageIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';

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
  'it binds the host’s variant of a multi-platform image, whose ONBUILD-free config impd inspected',
  async () => {
    const ctx = await setupTest();

    const multi = `${ctx.prefix}multi`;

    const busybox = await readBusyboxDigest();
    const hostArch = await readHostArch();

    const otherArch = hostArch === 'arm64' ? 'amd64' : 'arm64';
    const repository = 'e2e/multi';
    const index = `${ctx.registry.address}/${repository}:1`;
    const host = `${ctx.registry.address}/${repository}:${hostArch}`;
    const other = `${ctx.registry.address}/${repository}:${otherArch}`;

    // Registered before each build, whose image stays local if its push fails.
    // An rmi of an image that is not there only exits nonzero.
    ctx.stack.defer(async () => {
      await runCommand(['docker', 'rmi', host]);
    });

    await createPushedImage(
      writeContext(ctx.directoryPath, 'host', `FROM ${busybox}\nCOPY v /v\n`, hostArch),
      host,
      `linux/${hostArch}`,
    );

    ctx.stack.defer(async () => {
      await runCommand(['docker', 'rmi', other]);
    });

    // A trigger impd would refuse, and that fails the build if it ran.
    await createPushedImage(
      writeContext(
        ctx.directoryPath,
        'other',
        `FROM ${busybox}\nCOPY v /v\nONBUILD RUN false\n`,
        otherArch,
      ),
      other,
      `linux/${otherArch}`,
    );

    await writeRegistryIndex({
      registry: ctx.registry.address,
      ca: readFileSync(ctx.registry.certPath, 'utf8'),
      repository,
      tag: '1',
      entries: [
        { tag: hostArch, architecture: hostArch },
        { tag: otherArch, architecture: otherArch },
      ],
    });

    await runChecked(['docker', 'rmi', host, other]);

    ctx.stack.defer(async () => {
      await runCommand(['docker', 'rmi', index]);
    });

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, multi));

    await runImp(
      'image',
      'build',
      writeContext(ctx.directoryPath, 'build-multi', `FROM ${index}\nRUN cat /v\n`, ''),
      '--name',
      multi,
    );

    await createImageImp(ctx.stack, ctx.client, multi);

    const content = await runInImp(multi, 'cat', '/v');
    const references = await listManifestRequests(ctx.registry, repository);

    console.log(`    the registry saw manifest requests: ${references.join(', ')}`);

    expect(content).toBe(hostArch);
  },
);
