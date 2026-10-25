import type { CommandResult } from '../../../platform/process/run-command';
import { countTreeBytes } from '../../../vm/storage/count-tree-bytes';
import { startTarProcess } from './start-tar-process';
import { writeStreamedTree } from './write-streamed-tree';
import type { TreeLimits } from './write-streamed-tree';

export interface WriteOciTreeOptions {
  readonly ref: string;
  readonly root: string;
  readonly limits: Readonly<TreeLimits>;
  readonly signal: AbortSignal;
  readonly grow: (totalBytes: number, writtenBytes: number) => Promise<void>;
}

export function writeOciTree(options: Readonly<WriteOciTreeOptions>): Promise<void> {
  return writeStreamedTree({
    root: options.root,
    limits: options.limits,
    signal: options.signal,
    source: `oci-fetch export ${options.ref}`,
    grow: options.grow,
    startTar: startTarProcess,
    countTreeBytes,
    runExport: (onStdout, signal) =>
      runStreamed(['oci-fetch', 'export', options.ref], onStdout, signal),
  });
}

async function runStreamed(
  argv: readonly string[],
  onStdout: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    signal,
  });

  const stderr = new Response(child.stderr).text();

  try {
    for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
      await onStdout(chunk);
    }
  } catch (error) {
    child.kill();

    await child.exited;

    throw error;
  }

  const exitCode = await child.exited;

  signal.throwIfAborted();

  return { exitCode, stdout: '', stderr: await stderr };
}
