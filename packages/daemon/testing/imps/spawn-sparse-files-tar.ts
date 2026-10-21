import { onTestFinished } from 'bun:test';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// every chunk but the last has this size, so what a reader sees at each chunk never
// depends on how the pipe split tar's writes
const CHUNK_BYTES = 1024 ** 2;

export function spawnSparseFilesTar(directory: string, sizes: Readonly<Record<string, number>>) {
  const tree = mkdtempSync(join(directory, 'tree-'));

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

  return { stdout: splitChunks(tar.stdout, CHUNK_BYTES), exited: tar.exited };
}

async function* splitChunks(
  stream: ReadableStream<Uint8Array>,
  bytes: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  let pending = new Uint8Array(0);

  for await (const data of stream) {
    pending = Buffer.concat([pending, data]);

    while (pending.byteLength >= bytes) {
      yield pending.subarray(0, bytes);
      pending = pending.subarray(bytes);
    }
  }

  if (pending.byteLength > 0) {
    yield pending;
  }
}
