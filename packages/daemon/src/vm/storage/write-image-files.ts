import { writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeChangedBlocks } from './write-changed-blocks';

export interface ImageFiles {
  readonly rootfsPath: string;
  readonly configPath: string;
}

export async function writeImageFiles(files: ImageFiles, directory: string): Promise<void> {
  const rootfs = join(directory, 'rootfs.ext4');

  writeFileSync(rootfs, '');

  await writeChangedBlocks(files.rootfsPath, rootfs);
  await copyFile(files.configPath, join(directory, 'config.json'));
}
