import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { runCommand } from '../../src/platform/process/run-command';
import { createStubOciFetch } from './create-stub-oci-fetch';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'stub-oci-fetch-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it prints the digest and config of an image as oci-fetch config does', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      { ref: 'registry.test/builder@sha256:1', digest: 'sha256:2', config: { Env: ['A=1'] } },
    ],
  });

  const result = await runCommand(['oci-fetch', 'config', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
  });

  expect(JSON.parse(result.stdout)).toStrictEqual({
    digest: 'sha256:2',
    config: { Env: ['A=1'] },
  });
});

test('it writes the export tar of an image', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        exportTar: new TextEncoder().encode('a tar\n'),
      },
    ],
  });

  const result = await runCommand(['oci-fetch', 'export', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
  });

  expect(result.stdout).toBe('a tar\n');
});

test('it fails a fetch of an image it was not given as a registry would', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({ directory: ctx.directoryPath });

  const result = await runCommand(['oci-fetch', 'config', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
  });

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'oci-fetch: fetch registry.test/builder@sha256:1: MANIFEST_UNKNOWN: manifest unknown\n',
  });
});

test('it fails the config fetch with the stderr it was given', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: 'sha256:2',
        fetch: { stderr: 'oci-fetch: fetch registry.test/builder@sha256:1: UNAUTHORIZED' },
      },
    ],
  });

  const result = await runCommand(['oci-fetch', 'config', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
  });

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'oci-fetch: fetch registry.test/builder@sha256:1: UNAUTHORIZED\n',
  });
});

test('it holds a hanging config fetch until the signal ends it', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [{ ref: 'registry.test/builder@sha256:1', digest: 'sha256:2', fetch: 'hang' }],
  });

  const stop = new AbortController();

  const fetching = runCommand(['oci-fetch', 'config', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
    signal: stop.signal,
  });

  await waitFor(() => {
    expect(ociFetch.readCalls()).toStrictEqual(['config registry.test/builder@sha256:1']);
  });

  stop.abort();

  const result = await fetching;

  expect(result.exitCode).not.toBe(0);
});

test('it records each call in order', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [{ ref: 'registry.test/builder@sha256:1', digest: 'sha256:2' }],
  });

  await runCommand(['oci-fetch', 'config', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
  });

  await runCommand(['oci-fetch', 'export', 'registry.test/builder@sha256:1'], {
    env: { PATH: ociFetch.path },
  });

  expect(ociFetch.readCalls()).toStrictEqual([
    'config registry.test/builder@sha256:1',
    'export registry.test/builder@sha256:1',
  ]);
});
