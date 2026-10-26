import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeBuildContext } from '@impz/e2e-harness/build-context';
import { config } from '@impz/e2e-harness/config';
import { createInstanceClient, listImageNames, tryImp } from '@impz/e2e-harness/imp-cli';
import { REPO_ROOT, runChecked, runCommand } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImageIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  await mkdir(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  const buildRoot = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'build-'));

  stack.defer(() => rm(buildRoot, { recursive: true, force: true }));

  return { prefix: getSuitePrefix('images'), stack, client, buildRoot };
}

test('it refuses a RUN step that asks for the host network or insecure mode', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}runflags`;

  const hostNet = await writeBuildContext(
    ctx.buildRoot,
    'host-net',
    'FROM busybox:1.37\nRUN --network=host true\n',
  );

  const insecure = await writeBuildContext(
    ctx.buildRoot,
    'insecure',
    'FROM busybox:1.37\nRUN --security=insecure true\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const netResult = await tryImp(['image', 'build', hostNet, '--name', name]);
  const insecureResult = await tryImp(['image', 'build', insecure, '--name', name]);
  const images = await listImageNames();

  expect(netResult).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('network.host is not allowed'),
  });

  expect(insecureResult).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('security.insecure is not allowed'),
  });

  expect(images).not.toContain(name);
});

test('it fails the pull of a FROM image that only the host’s Docker has', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}localfrom`;

  // The host engine's tags are shared: refuse one this test did not make.
  const local = 'e2e-img-localbase:1';

  const existing = await runCommand(['docker', 'image', 'inspect', local]);

  expect(existing.exitCode, `${local} is already on the host's Docker`).not.toBe(0);

  const baseDir = await writeBuildContext(
    ctx.buildRoot,
    'local-base-image',
    'FROM busybox:1.37\nRUN echo local > /m\n',
  );

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'local-base',
    `FROM ${local}\nRUN grep local /m\n`,
  );

  await runChecked(['docker', 'build', '--quiet', '--tag', local, baseDir]);

  ctx.stack.defer(async () => {
    await runCommand(['docker', 'rmi', local]);
  });

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', directory, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude(`FROM ${local}: the pull failed`),
  });
});

test('it refuses a FROM image from the host’s own registry under the proxy’s pull rules', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}hostreg`;

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'missing-base',
    'FROM localhost:5000/e2e-missing:1\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', directory, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude("registry localhost:5000 is the host's own"),
  });
});

test.each([
  ['a plain URL', 'plain', 'ADD {url} /probe', 'ADD {url} is refused'],
  ['a URL in the JSON form', 'json', 'ADD ["{url}", "/probe"]', 'ADD {url} is refused'],
  [
    'a URL with a quoted scheme',
    'quoted',
    'ADD h"ttp:"//127.0.0.1:{port}/probe /probe',
    'an ambiguous form: the ADD source',
  ],
  [
    'a git address',
    'git',
    'ADD git@127.0.0.1:org/repo.git /src',
    'ADD git@127.0.0.1:org/repo.git is refused',
  ],
])('it refuses an ADD from %s, unseen by its listener', async (_label, tag, line, refusal) => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}add-${tag}`;
  const requests: string[] = [];

  const handleListenerRequest = (request: Request) => {
    requests.push(request.url);

    return new Response('probe');
  };

  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handleListenerRequest,
  });

  ctx.stack.defer(() => listener.stop(true));

  const port = String(listener.port);
  const url = `http://127.0.0.1:${port}/probe`;
  const step = line.replaceAll('{url}', url).replaceAll('{port}', port);

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'add-url',
    `FROM busybox:1.37\n${step}\n`,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', directory, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude(refusal.replaceAll('{url}', url)),
  });

  expect(requests).toStrictEqual([]);
});

test('it refuses ONBUILD, also in a local stage a later FROM runs', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}onbuild`;

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'onbuild',
    'FROM busybox:1.37 AS base\nONBUILD RUN echo trigger > /t\nFROM base\nRUN true\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', directory, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('ONBUILD is refused'),
  });
});

test('it fails a build in its builder whose FROM registry name resolves to a private address', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}privfrom`;

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'private-registry',
    'FROM 10-0-0-1.nip.io:5000/e2e/x:1\n',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'build', directory, '--name', name]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toIncludeMultiple([
      'FROM 10-0-0-1.nip.io:5000/e2e/x:1: the pull failed',
      'no such host',
    ]),
  });
});

test('it fails an add in its builder whose registry name resolves to a private address', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}privadd`;

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const result = await tryImp(['image', 'add', '10-0-0-1.nip.io:5000/e2e/x:1', '--name', name]);
  const names = await listImageNames();

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('the pull of 10-0-0-1.nip.io:5000/e2e/x:1 in the builder failed'),
  });

  expect(names).not.toContain(name);
});
