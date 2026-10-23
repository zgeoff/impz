import * as z from 'zod';
import { ImpdError } from '../../platform/errors/impd-error';
import type { StartTimer } from '../../platform/process/clock';
import { startRealTimer } from '../../platform/process/start-real-timer';
import { countTreeBytes } from '../../vm/storage/count-tree-bytes';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import type { BuildOutput } from './create-build-steps';
import { createPlainLines } from './create-plain-lines';
import { DockerBuildError } from './docker-build-error';
import type { GuestExec } from './guest-exec';
import { ImageLimitError } from './image-limit-error';
import { PIN_INSPECT_FORMAT, PinInspectSchema, formatPlatform, pickRepoDigest } from './image-pin';
import { planRootfsOverhead } from './rootfs-plan';
import { UNPACK_TAR_ARGS, assertUnpacked } from './unpack-export';

const GUEST_BUILD_TAG = 'imp-build:latest';
const LOG_MAX_CHARS = 8000;
const ContainerIdSchema = z.string().regex(/^[a-f0-9]{64}$/v);
const OciConfigSchema = z.record(z.string(), z.unknown()).nullable();

export interface GuestBuildOptions {
  readonly tarPath: string;

  readonly dockerfile: string;
  readonly signal: AbortSignal;

  readonly output?: BuildOutput | undefined;
}

export async function runGuestBuild(
  exec: GuestExec,
  options: Readonly<GuestBuildOptions>,
): Promise<void> {
  const lines = options.output === undefined ? null : createPlainLines(options.output);

  const result = await exec(
    [
      'docker',
      'build',
      '--progress=plain',
      '--build-arg',
      `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
      '--tag',
      GUEST_BUILD_TAG,
      '--file',
      options.dockerfile,
      '-',
    ],
    {
      stdinPath: options.tarPath,
      signal: options.signal,
      ...(lines !== null && { onStderr: lines.readChunk }),
    },
  );

  lines?.flush();

  if (result.exitCode !== 0) {
    const log = `${result.stdout}${result.stderr}`.trim().slice(-LOG_MAX_CHARS);

    throw new DockerBuildError(`docker build failed:\n${log}`);
  }
}

export interface GuestPullOptions {
  readonly ref: string;

  readonly platform: string;
  readonly signal: AbortSignal;
}

export async function loadGuestImage(
  exec: GuestExec,
  options: Readonly<GuestPullOptions>,
): Promise<string | null> {
  const ref = options.ref;
  const signal = options.signal;

  const pulled = await exec(['docker', 'pull', '--quiet', '--platform', options.platform, ref], {
    signal,
  });

  if (pulled.exitCode !== 0) {
    throw new ImpdError('BAD_REQUEST', {
      message: `the pull of ${ref} in the builder failed: ${pulled.stderr.trim().slice(-LOG_MAX_CHARS)}`,
    });
  }

  const inspected = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, ref],
    {
      signal,
    },
  );

  if (inspected.exitCode !== 0) {
    throw new Error(`docker image inspect ${ref} in the builder: ${inspected.stderr.trim()}`);
  }

  const inspect = PinInspectSchema.parse(JSON.parse(inspected.stdout));
  const imagePlatform = formatPlatform(inspect.Os, inspect.Architecture);

  if (imagePlatform !== options.platform) {
    throw new ImpdError('BAD_REQUEST', {
      message: `${ref} pulled for ${imagePlatform}, not ${options.platform}`,
    });
  }

  const tagged = await exec(['docker', 'tag', ref, GUEST_BUILD_TAG], { signal });

  if (tagged.exitCode !== 0) {
    throw new Error(`docker tag in the builder: ${tagged.stderr.trim()}`);
  }

  return pickRepoDigest(ref, inspect.RepoDigests ?? []);
}

const DIGEST_PREFIX = 'imp-build-';
const DIGEST_DOMAIN = 'imp build image v1\n';

export interface ExportedImage {
  // impd hashes the export as it reads it, so the builder names nothing on the host.
  readonly digest: string;
  readonly config: z.infer<typeof OciConfigSchema>;
}

interface ExportLimits {
  readonly maxBytes: number;

  // Counted from tar's own listing, so an archive cannot hide entries from a second parser.
  readonly maxFiles: number;
}

const EXPORT_IDLE_MS = 120_000;
const GROW_STEP_BYTES = 256 * 1024 ** 2;

const TAR_STOPPED = new Error('tar stopped before the export ended');

function createImageHash(configText: string): Bun.CryptoHasher {
  const config = new TextEncoder().encode(configText);
  const length = new Uint8Array(8);

  new DataView(length.buffer).setBigUint64(0, BigInt(config.byteLength));

  const hash = new Bun.CryptoHasher('sha256');

  hash.update(DIGEST_DOMAIN);
  hash.update(length);
  hash.update(config);

  return hash;
}

const BLOCK_BYTES = 4096;

// The third field of a `tar -vv` line is the entry's logical size, a sparse file's full
// length.
function readAllocatedBytes(line: string): number {
  const size = line.trim().split(/\s+/v)[2] ?? '';
  const bytes = /^\d+$/v.test(size) ? Number(size) : 0;

  return Math.max(1, Math.ceil(bytes / BLOCK_BYTES)) * BLOCK_BYTES;
}

// tar -vv prints one line per entry it unpacks, and a "Creating directory:" line for each
// parent a member names that the archive lacks.
async function countUnpacked(
  stdout: ReadableStream<Uint8Array>,
  limits: Readonly<ExportLimits>,
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

interface WriteGuestTreeOptions {
  readonly exec: GuestExec;
  readonly root: string;
  readonly limits: Readonly<ExportLimits>;
  readonly signal: AbortSignal;
  readonly grow?: (totalBytes: number, writtenBytes: number) => Promise<void>;
  readonly startTimer?: StartTimer;
}

export async function writeGuestTree(options: WriteGuestTreeOptions): Promise<ExportedImage> {
  const exec = options.exec;
  const root = options.root;
  const limits = options.limits;
  const signal = options.signal;
  const grow = options.grow ?? (() => Promise.resolve());
  const startTimer = options.startTimer ?? startRealTimer;
  const maxBytes = limits.maxBytes;

  const inspected = await exec(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', GUEST_BUILD_TAG],
    { signal },
  );

  if (inspected.exitCode !== 0) {
    throw new Error(`docker image inspect in the builder: ${inspected.stderr.trim()}`);
  }

  const configText = inspected.stdout.trim();
  const config = OciConfigSchema.parse(JSON.parse(configText));

  const created = await exec(['docker', 'create', GUEST_BUILD_TAG, '/bin/true'], { signal });

  if (created.exitCode !== 0) {
    throw new Error(`docker create in the builder: ${created.stderr.trim()}`);
  }

  const containerId = ContainerIdSchema.parse(created.stdout.trim());

  const tar = Bun.spawn([...UNPACK_TAR_ARGS, '-vv', '--quoting-style=escape', '-C', root], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C' },
  });

  const hash = createImageHash(configText);
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

      const writtenBytes = await countTreeBytes(root);

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
      new Error(`docker export in the builder sent nothing in ${String(EXPORT_IDLE_MS / 1000)} s`),
    );
  };

  const idle = { cancel: startTimer(stopIdle, EXPORT_IDLE_MS) };

  const stderrText = new Response(tar.stderr).text();

  try {
    const exported = await exec(['docker', 'export', containerId], {
      signal: AbortSignal.any([signal, stopExport.signal]),
      onStdout: async (chunk) => {
        idle.cancel();

        idle.cancel = startTimer(stopIdle, EXPORT_IDLE_MS);
        sent.bytes += chunk.byteLength;

        if (sent.bytes > maxBytes) {
          throw new ImageLimitError('bytes', maxBytes);
        }

        assertWithinLimits();

        await growHold();

        hash.update(chunk);

        await tar.stdin.write(chunk);
        await tar.stdin.flush();
      },
    });

    if (exported.exitCode !== 0) {
      throw new Error(`docker export in the builder: ${exported.stderr.trim()}`);
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

  return { digest: `${DIGEST_PREFIX}${hash.digest('hex')}`, config };
}
