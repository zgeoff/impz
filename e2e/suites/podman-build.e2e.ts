import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeBuildContext } from '../lib/build-context';
import { config } from '../lib/config';
import { createInstanceClient, listImages, runImp, runInImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { REPO_ROOT } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImageIfPresent, removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// One stack for every release, so the imp goes before the image it boots.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  await mkdir(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  const buildRoot = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'podman-'));

  stack.defer(() => rm(buildRoot, { recursive: true, force: true }));

  return { prefix: getSuitePrefix('podman'), stack, client, buildRoot };
}

test('it holds the builder image that impd fetched by digest from its registry', async () => {
  // A fresh impd fetches the builder at start, to seed its default image.
  const images = await waitFor(
    'impd to add its builder image',
    async () => {
      const listed = await listImages();

      if (!listed.some((image) => image.name === 'imp-builder')) {
        throw new Error('no imp-builder image yet');
      }

      return listed;
    },
    { timeoutMs: 600_000 },
  );

  expect(images).toContainEqual({
    name: 'imp-builder',
    ref: expect.stringMatching(/@sha256:[0-9a-f]{64}$/v),
    source: 'oci',
  });
});

test('it builds an image from a Dockerfile in a builder, and an imp from that image holds what the build wrote', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}greeting`;

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'greeting',
    'FROM alpine\nRUN echo hello-from-a-build > /greeting\n',
  );

  await runImp('image', 'build', directory, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  await runImp('new', name, '--image', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const greeting = await runInImp(name, 'cat', '/greeting');

  expect(greeting).toBe('hello-from-a-build');
});
