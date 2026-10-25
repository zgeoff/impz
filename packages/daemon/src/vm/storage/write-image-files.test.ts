import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeImageFiles } from './write-image-files';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'impd-image-files-test-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it writes the rootfs and the config into the image directory', async () => {
  const ctx = setupTest();
  const rootfs = Buffer.alloc(2 * 1024 ** 2, 3);
  const target = join(ctx.directory, 'image');

  mkdirSync(target);
  writeFileSync(join(ctx.directory, 'received.ext4'), rootfs);
  writeFileSync(join(ctx.directory, 'received.json'), '{"entrypoint":["/bin/sh"]}');

  await writeImageFiles(
    {
      rootfsPath: join(ctx.directory, 'received.ext4'),
      configPath: join(ctx.directory, 'received.json'),
    },
    target,
  );

  expect(readFileSync(join(target, 'rootfs.ext4'))).toStrictEqual(rootfs);
  expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('{"entrypoint":["/bin/sh"]}');
});
