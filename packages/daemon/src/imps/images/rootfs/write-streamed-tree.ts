import type { StartTimer } from '../../../platform/process/clock';
import type { CommandResult } from '../../../platform/process/run-command';
import { ImageLimitError } from '../build/image-limit-error';
import { planRootfsOverhead } from './rootfs-plan';
import { UNPACK_TAR_ARGS, assertUnpacked } from './unpack-export';

export interface TreeLimits {
  readonly maxBytes: number;

  // Counted from tar's own listing, so an archive cannot hide entries from a second parser.
  readonly maxFiles: number;
}

export type TarProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

type StartTar = (argv: readonly string[]) => TarProcess;

export interface WriteStreamedTreeOptions {
  readonly root: string;
  readonly limits: Readonly<TreeLimits>;
  readonly signal: AbortSignal;

  readonly source: string;

  readonly startTar: StartTar;

  readonly countTreeBytes: (root: string) => Promise<number>;

  readonly runExport: (
    onStdout: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<CommandResult>;

  readonly grow?: ((totalBytes: number, writtenBytes: number) => Promise<void>) | undefined;
  readonly startTimer: StartTimer;
}

const EXPORT_IDLE_MS = 120_000;
const GROW_STEP_BYTES = 256 * 1024 ** 2;

const TAR_STOPPED = new Error('tar stopped before the export ended');

export async function writeStreamedTree(
  options: Readonly<WriteStreamedTreeOptions>,
): Promise<void> {
  const root = options.root;
  const limits = options.limits;
  const grow = options.grow ?? (() => Promise.resolve());
  const startTimer = options.startTimer;
  const maxBytes = limits.maxBytes;
  const tar = options.startTar([...UNPACK_TAR_ARGS, '-vv', '--quoting-style=escape', '-C', root]);
  const sent = { bytes: 0 };
  const unpacked: { over?: 'bytes' | 'files'; ended?: boolean } = {};

  const stopExport = new AbortController();

  const readMax = (limit: 'bytes' | 'files') => (limit === 'bytes' ? maxBytes : limits.maxFiles);

  // tar's listing can arrive only as tar exits, after the end of the archive and before the
  // end of the export.
  const listed = { bytes: 0 };
  const held = { bytes: 0 };

  const growHold = async () => {
    const tree = Math.max(sent.bytes, listed.bytes);
    const needed = 2 * tree + planRootfsOverhead(tree);

    if (needed > held.bytes) {
      held.bytes = (Math.floor(needed / GROW_STEP_BYTES) + 1) * GROW_STEP_BYTES;

      const writtenBytes = await options.countTreeBytes(root);

      await grow(held.bytes, writtenBytes);
    }
  };

  const onCounted = (bytes: number) => {
    listed.bytes = bytes;
  };

  const counting = countUnpacked(tar.stdout, limits, onCounted, (limit) => {
    unpacked.over = limit;

    const max = readMax(limit);

    tar.kill();
    stopExport.abort(new ImageLimitError(limit, max));
  });

  const waitForTar = async () => {
    const code = await tar.exited;

    if (code !== 0 && unpacked.ended !== true) {
      stopExport.abort(TAR_STOPPED);
    }
  };

  void waitForTar();

  const assertWithinLimits = () => {
    const over = unpacked.over;

    if (over !== undefined) {
      throw new ImageLimitError(over, readMax(over));
    }
  };

  const stopIdle = () => {
    stopExport.abort(
      new Error(`${options.source} sent nothing in ${String(EXPORT_IDLE_MS / 1000)} s`),
    );
  };

  const idle = { cancel: startTimer(stopIdle, EXPORT_IDLE_MS) };

  const stderrText = new Response(tar.stderr).text();

  try {
    const exported = await options.runExport(
      async (chunk) => {
        idle.cancel();

        idle.cancel = startTimer(stopIdle, EXPORT_IDLE_MS);
        sent.bytes += chunk.byteLength;

        if (sent.bytes > maxBytes) {
          throw new ImageLimitError('bytes', maxBytes);
        }

        assertWithinLimits();

        await growHold();

        await tar.stdin.write(chunk);
        await tar.stdin.flush();
      },
      AbortSignal.any([options.signal, stopExport.signal]),
    );

    if (exported.exitCode !== 0) {
      throw new Error(`${options.source}: ${exported.stderr.trim()}`);
    }

    unpacked.ended = true;

    await tar.stdin.end();

    const [exitCode, stderr] = await Promise.all([tar.exited, stderrText, counting]);

    assertWithinLimits();
    assertUnpacked({ exitCode, stdout: '', stderr });

    await growHold();
  } catch (error) {
    tar.kill();

    assertWithinLimits();

    if (stopExport.signal.reason === TAR_STOPPED) {
      const [exitCode, stderr] = await Promise.all([tar.exited, stderrText]);

      assertUnpacked({ exitCode, stdout: '', stderr });
    }

    throw error;
  } finally {
    idle.cancel();
  }
}

// tar -vv prints one line per entry it unpacks, and a "Creating directory:" line for each
// parent a member names that the archive lacks.
async function countUnpacked(
  stdout: ReadableStream<Uint8Array>,
  limits: Readonly<TreeLimits>,
  onCounted: (bytes: number) => void,
  onOver: (limit: 'bytes' | 'files') => void,
): Promise<void> {
  const decoder = new TextDecoder();

  const counted = { lines: 0, bytes: 0, rest: '' };

  for await (const chunk of stdout as AsyncIterable<Uint8Array>) {
    const lines = `${counted.rest}${decoder.decode(chunk, { stream: true })}`.split('\n');

    counted.rest = lines.pop() ?? '';

    for (const line of lines) {
      counted.lines += 1;
      counted.bytes += readAllocatedBytes(line);
    }

    onCounted(counted.bytes);

    if (counted.bytes > limits.maxBytes) {
      onOver('bytes');

      return;
    }

    if (counted.lines > limits.maxFiles) {
      onOver('files');

      return;
    }
  }
}

const BLOCK_BYTES = 4096;

// The third field of a `tar -vv` line is the entry's logical size, a sparse file's full
// length.
function readAllocatedBytes(line: string): number {
  const size = line.trim().split(/\s+/v)[2] ?? '';
  const bytes = /^\d+$/v.test(size) ? Number(size) : 0;

  return Math.max(1, Math.ceil(bytes / BLOCK_BYTES)) * BLOCK_BYTES;
}
