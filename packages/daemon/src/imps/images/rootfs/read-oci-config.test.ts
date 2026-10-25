import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { createStubOciFetch } from '../../../../testing/imps/create-stub-oci-fetch';
import { readOciConfig } from './read-oci-config';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'read-oci-config-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it reads the digest and runtime config oci-fetch prints', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [
      {
        ref: 'registry.test/builder@sha256:1',
        digest: `sha256:${'a'.repeat(64)}`,
        config: { Env: ['PATH=/usr/bin'] },
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);

  const image = await readOciConfig('registry.test/builder@sha256:1', new AbortController().signal);

  expect(image).toStrictEqual({
    digest: `sha256:${'a'.repeat(64)}`,
    config: { Env: ['PATH=/usr/bin'] },
  });
});

test('it runs oci-fetch config through the given command runner', async () => {
  const signal = new AbortController().signal;

  const run = mock(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: `{"digest":"sha256:${'b'.repeat(64)}","config":null}\n`,
      stderr: '',
    }),
  );

  const image = await readOciConfig('registry.test/builder@sha256:1', signal, run);

  expect(image).toStrictEqual({ digest: `sha256:${'b'.repeat(64)}`, config: null });

  expect(run).toHaveBeenCalledExactlyOnceWith(
    ['oci-fetch', 'config', 'registry.test/builder@sha256:1'],
    {
      signal,
    },
  );
});

test('it fails with the stderr of a fetch that fails', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({ directory: ctx.directoryPath });

  updateEnv('PATH', ociFetch.path);

  expect(
    readOciConfig('registry.test/builder@sha256:1', new AbortController().signal),
  ).rejects.toThrowWithMessage(
    Error,
    'oci-fetch config registry.test/builder@sha256:1 exited 1: oci-fetch: fetch registry.test/builder@sha256:1: MANIFEST_UNKNOWN: manifest unknown',
  );
});

test('it refuses a digest that is not a sha256 digest', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [{ ref: 'registry.test/builder@sha256:1', digest: '../escape' }],
  });

  updateEnv('PATH', ociFetch.path);

  expect(
    readOciConfig('registry.test/builder@sha256:1', new AbortController().signal),
  ).rejects.toMatchObject({
    issues: expect.arrayContaining([expect.objectContaining({ path: ['digest'] })]) as unknown,
  });
});

test('it ends the fetch with the reason of the signal that stops it', async () => {
  const ctx = await setupTest();

  const ociFetch = createStubOciFetch({
    directory: ctx.directoryPath,
    images: [{ ref: 'registry.test/builder@sha256:1', digest: 'sha256:2', fetch: 'hang' }],
  });

  const stop = new AbortController();

  updateEnv('PATH', ociFetch.path);

  const reading = readOciConfig('registry.test/builder@sha256:1', stop.signal);

  stop.abort(new Error('the limit passed'));

  expect(reading).rejects.toThrowWithMessage(Error, 'the limit passed');
});
