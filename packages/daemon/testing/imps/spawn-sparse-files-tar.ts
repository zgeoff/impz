import { onTestFinished } from 'bun:test';
import { spawn } from 'node:child_process';
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

  // node:child_process, not Bun.spawn: Bun reads a piped stdout ahead into
  // memory, so a test that stops reading a 200 MiB tar can still hold all of it
  const tar = spawn('tar', ['-C', tree, '-c', ...Object.keys(sizes)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();

  tar.once('exit', (code, signal) => {
    exited.resolve({ code, signal });
  });

  // a test whose build stops reading leaves tar blocked on its output
  onTestFinished(() => {
    tar.kill();
  });

  return { stdout: splitChunks(tar.stdout, CHUNK_BYTES), exited: exited.promise };
}

async function* splitChunks(
  stream: AsyncIterable<Uint8Array>,
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
