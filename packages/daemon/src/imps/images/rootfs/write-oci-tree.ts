import type { StreamedRunner } from '../../../platform/process/run-streamed';
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
  readonly runStreamed: StreamedRunner;
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
      options.runStreamed(['oci-fetch', 'export', options.ref], onStdout, signal),
  });
}
