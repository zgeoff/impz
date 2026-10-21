import { expect, test } from 'bun:test';
import type { StorageBackend } from '../../src/vm/storage/storage-backend';
import { buildStubPublishHook } from './build-stub-publish-hook';

test('it runs the hook with the digest once the wrapped create finishes', async () => {
  const calls: string[] = [];
  const hook = buildStubPublishHook();

  const storage = hook.wrap({
    createImage: async (digest: string, write: (directory: string) => Promise<void>) => {
      await write('/staged');

      calls.push(`create ${digest}`);
    },
  });

  hook.setAfterPublish((digest) => {
    calls.push(`after ${digest}`);

    return Promise.resolve();
  });

  await storage.createImage('sha256:1', (directory) => {
    calls.push(`write ${directory}`);

    return Promise.resolve();
  });

  expect(calls).toStrictEqual(['write /staged', 'create sha256:1', 'after sha256:1']);
});

test('it runs no hook until one is set', async () => {
  const calls: string[] = [];
  const hook = buildStubPublishHook();

  const created: Pick<StorageBackend, 'createImage'> = {
    createImage: (digest) => {
      calls.push(`create ${digest}`);

      return Promise.resolve();
    },
  };

  const storage = hook.wrap(created);

  await storage.createImage('sha256:1', () => Promise.resolve());

  expect(calls).toStrictEqual(['create sha256:1']);
});
