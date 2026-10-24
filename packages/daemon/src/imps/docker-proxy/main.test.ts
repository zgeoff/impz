import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { readInBackground } from '../../../testing/platform/read-in-background';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'docker-proxy-main-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory };
}

test('it logs where it listens, the engine and the images it allows when it starts', async () => {
  const ctx = await setupTest();

  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: {
      PATH: process.env['PATH'] ?? '',
      IMP_DOCKER_PROXY_LISTEN: join(ctx.directory, 'docker.sock'),
      IMP_DOCKER_PROXY_UPSTREAM: join(ctx.directory, 'engine.sock'),
      IMP_DOCKER_PROXY_STATE: ctx.directory,
      IMP_HOST_IMAGE: 'ghcr.io/example/imp-host:1.0.0',
      IMP_BUILD_IMAGE: `ghcr.io/example/imp-base:1.0.0@sha256:${'a'.repeat(64)}`,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  onTestFinished(() => {
    child.kill();
  });

  const output = readInBackground(child.stdout.pipeThrough(new TextDecoderStream()));

  const text = await waitFor(() => {
    const joined = output.items.join('');

    invariant(joined.endsWith('\n'), 'no whole line yet');

    return joined;
  });

  expect(text).toBe(
    `INFO impd.docker-proxy imp-docker-proxy on ${join(ctx.directory, 'docker.sock')}, engine ${join(ctx.directory, 'engine.sock')}, host image ghcr.io/example/imp-host:1.0.0, pulls only ghcr.io/example/imp-base:1.0.0@sha256:${'a'.repeat(64)}, no builds\n`,
  );
});

test('it refuses to start without IMP_HOST_IMAGE', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: '' },
  });

  expect(result.exitCode).not.toBe(0);

  expect(result.stderr.toString()).toInclude(
    'IMP_HOST_IMAGE is not set; set it to the image this proxy runs from',
  );
});

test('it refuses to start with an IMP_BUILD_IMAGE that names no digest', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: 'x', IMP_BUILD_IMAGE: 'busybox:1.37' },
  });

  expect(result.exitCode).not.toBe(0);

  expect(result.stderr.toString()).toInclude(
    'IMP_BUILD_IMAGE is busybox:1.37, not an image by digest, <ref>@sha256:<hex>',
  );
});
