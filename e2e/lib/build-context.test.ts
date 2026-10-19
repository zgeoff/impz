import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { updateEnv } from '@impz/test-utils/update-env';
import { createStubDockerBin } from '../../packages/client/src/test-utils/create-stub-docker-bin';
import { startStubDockerEngine } from '../../packages/client/src/test-utils/start-stub-docker-engine';
import { startTestImpd } from '../../packages/daemon/testing';
import { sendRawBuild, writeBuildContext } from './build-context';

// impd's real app on the stub VMM and a loopback port, building on the host
// engine at `dockerSocket`; `root` holds the test's contexts, engine and
// docker CLI
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const dockerSocket = join(root, 'docker.sock');

  // impd boots with a root token, the bearer a raw build sends
  const rootToken = faker.string.alphanumeric(32);

  // builds run on the host engine, as no builder imp has an agent here;
  // impd listens with its own body limit, so the build route, not Bun,
  // refuses a large context
  const harness = await startTestImpd(stack, {
    dataDir: join(root, 'data'),
    rootToken,
    env: { IMP_BUILD_ISOLATION: 'host', DOCKER_HOST: `unix://${dockerSocket}` },
  });

  return {
    root,
    dockerSocket,
    rootToken,
    apiUrl: harness.url,
  };
}

test('#writeBuildContext makes a named directory that holds the Dockerfile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const dir = await writeBuildContext(root, 'syntax', 'FROM busybox:1.37\n');
  const dockerfile = await readFile(join(root, 'syntax', 'Dockerfile'), 'utf8');

  expect(dir).toBe(join(root, 'syntax'));
  expect(dockerfile).toBe('FROM busybox:1.37\n');
});

test('#sendRawBuild builds a tar of exactly the named files on impd under the token and image name', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.root, {
    'imp/e2e-img-raw:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  const engine = startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM scratch\nCOPY kept.txt /\n');

  await writeFile(join(dir, 'kept.txt'), 'kept');
  await writeFile(join(dir, 'left-out.txt'), 'left out');

  const response = await sendRawBuild({
    apiUrl: ctx.apiUrl,
    token: ctx.rootToken,
    dir,
    files: ['Dockerfile', 'kept.txt'],
    name: 'e2e-img-raw',
  });

  const built: unknown = await response.json();

  const listed = Bun.spawnSync(['tar', '-tf', '-'], {
    stdin: engine.contexts.at(0) ?? new Uint8Array(),
  }).stdout.toString();

  expect(response.status).toBe(200);
  expect(built).toMatchObject({ name: 'e2e-img-raw', ref: 'imp/e2e-img-raw:latest' });
  expect(listed).toBe('Dockerfile\nkept.txt\n');
});

test('#sendRawBuild answers impd’s refusal of another token', async () => {
  const ctx = await setupTest();
  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  const response = await sendRawBuild({
    apiUrl: ctx.apiUrl,
    token: 'imp_wrong',
    dir,
    files: ['Dockerfile'],
    name: 'e2e-img-raw',
  });

  expect(response.status).toBe(401);
});

test('#sendRawBuild throws with tar’s reason when a named file is missing', async () => {
  const ctx = await setupTest();
  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  expect(
    sendRawBuild({
      apiUrl: ctx.apiUrl,
      token: ctx.rootToken,
      dir,
      files: ['missing.txt'],
      name: 'e2e-img-raw',
    }),
  ).rejects.toThrowWithMessage(Error, /^tar exited 2: .*missing\.txt/u);
});
