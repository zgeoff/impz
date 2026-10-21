import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function createTreeTar(
  directory: string,
  make: (tree: string) => void,
  tarArgs: readonly string[] = [],
): Uint8Array {
  const tree = mkdtempSync(join(directory, 'tree-'));

  make(tree);

  const tar = Bun.spawnSync(
    ['tar', '--owner=0', '--group=0', '--numeric-owner', ...tarArgs, '-C', tree, '-c', '.'],
    { maxBuffer: 2 * 1024 ** 3 },
  );

  rmSync(tree, { recursive: true, force: true });

  if (tar.exitCode !== 0) {
    throw new Error(`tar exited ${String(tar.exitCode)}: ${tar.stderr.toString().trim()}`);
  }

  return tar.stdout;
}
