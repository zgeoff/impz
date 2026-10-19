import { onTestFinished } from 'bun:test';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A running tar, which ends with the test, of a fresh directory in `dir`
// that holds a sparse file of each size, each named on its command line:
// a builder's export of a large tree, on no disk and in no buffer
export function spawnSparseFilesTar(dir: string, sizes: Readonly<Record<string, number>>) {
  const tree = mkdtempSync(join(dir, 'tree-'));

  for (const [name, bytes] of Object.entries(sizes)) {
    writeFileSync(join(tree, name), '');
    truncateSync(join(tree, name), bytes);
  }

  const tar = Bun.spawn(['tar', '-C', tree, '-c', ...Object.keys(sizes)], {
    stdout: 'pipe',
    stderr: 'ignore',
  });

  // a test whose build stops reading leaves tar blocked on its output
  onTestFinished(() => {
    tar.kill();
  });

  return { stdout: tar.stdout, exited: tar.exited };
}
