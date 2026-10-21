import type { StorageBackend } from '../../src/vm/storage/storage-backend';

type AfterPublish = (digest: string) => Promise<unknown>;

// Runs work in the window between a rootfs landing and the caller writing the image's row.
export function buildStubPublishHook() {
  const hook: { after: AfterPublish } = { after: () => Promise.resolve() };

  return {
    wrap: <T extends Pick<StorageBackend, 'createImage'>>(storage: T): T => ({
      ...storage,
      createImage: async (digest: string, write: (directory: string) => Promise<void>) => {
        await storage.createImage(digest, write);
        await hook.after(digest);
      },
    }),
    setAfterPublish: (after: AfterPublish) => {
      hook.after = after;
    },
  };
}
