import * as z from 'zod';
import { ImpdError } from '../../../platform/errors/impd-error';
import type { StartTimer } from '../../../platform/process/clock';
import { DOCKERFILE_FRONTEND } from '../../docker-contract/dockerfile-frontend';
import type { GuestExec } from '../builders/guest-exec';
import { formatFailureTail } from '../pull/format-failure-tail';
import { pickRepoDigest, requireImagePlatform } from '../pull/image-pin';
import { readImageInspect } from '../pull/read-image-inspect';
import { writeStreamedTree } from '../rootfs/write-streamed-tree';
import type { TreeLimits, WriteStreamedTreeOptions } from '../rootfs/write-streamed-tree';
import { toEngineRun } from './build-engine';
import type { BuildOutput } from './create-build-steps';
import { createPlainLines } from './create-plain-lines';
import { DockerBuildError } from './docker-build-error';

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
      message: `the pull of ${ref} in the builder failed: ${formatFailureTail(pulled.stderr)}`,
    });
  }

  const inspect = await readImageInspect(toEngineRun(exec), ref, signal);

  if (inspect === null) {
    throw new Error(`docker image inspect ${ref} failed after its pull in the builder`);
  }

  requireImagePlatform(ref, inspect, options.platform);

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

interface WriteGuestTreeOptions {
  readonly exec: GuestExec;
  readonly root: string;
  readonly limits: Readonly<TreeLimits>;
  readonly signal: AbortSignal;
  readonly grow?: (totalBytes: number, writtenBytes: number) => Promise<void>;
  readonly startTimer: StartTimer;
  readonly startTar: WriteStreamedTreeOptions['startTar'];
  readonly countTreeBytes: WriteStreamedTreeOptions['countTreeBytes'];
}

export async function writeGuestTree(options: WriteGuestTreeOptions): Promise<ExportedImage> {
  const exec = options.exec;
  const signal = options.signal;

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
  const hash = createImageHash(configText);

  await writeStreamedTree({
    root: options.root,
    limits: options.limits,
    signal,
    source: 'docker export in the builder',
    grow: options.grow,
    startTimer: options.startTimer,
    startTar: options.startTar,
    countTreeBytes: options.countTreeBytes,
    runExport: (onStdout, exportSignal) =>
      exec(['docker', 'export', containerId], {
        signal: exportSignal,
        onStdout: async (chunk) => {
          await onStdout(chunk);

          hash.update(chunk);
        },
      }),
  });

  return { digest: `${DIGEST_PREFIX}${hash.digest('hex')}`, config };
}

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
