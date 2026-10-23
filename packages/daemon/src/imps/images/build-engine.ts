import * as z from 'zod';
import { ImpdError } from '../../platform/errors/impd-error';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import type { ExternalImage } from './dockerfile-check';
import type { GuestExec } from './guest-exec';
import { PIN_INSPECT_FORMAT, PinInspectSchema, normalizePlatform } from './image-pin';
import type { PinInspect } from './image-pin';

const FAILURE_MAX_CHARS = 4000;

interface EngineResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type EngineRun = (argv: readonly string[], signal: AbortSignal) => Promise<EngineResult>;

export interface BuildEngine {
  readonly readPlatform: (signal: AbortSignal) => Promise<string>;

  readonly loadImage: (image: Readonly<ExternalImage>, signal: AbortSignal) => Promise<PinInspect>;

  // Docker engines before 29.6.0 fetch the BUILDKIT_SYNTAX frontend only through a client
  // session, which a host build lacks, so the frontend is pulled by digest first.
  readonly loadFrontend: (signal: AbortSignal) => Promise<void>;
}

export function createBuildEngine(run: EngineRun): BuildEngine {
  const runAborting = async (argv: readonly string[], signal: AbortSignal) => {
    const result = await run(argv, signal);

    signal.throwIfAborted();

    return result;
  };

  const readPinInspect = async (ref: string, signal: AbortSignal): Promise<PinInspect | null> => {
    const inspected = await runAborting(
      ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, ref],
      signal,
    );

    if (inspected.exitCode !== 0) {
      return null;
    }

    return PinInspectSchema.parse(JSON.parse(inspected.stdout));
  };

  return {
    readPlatform: async (signal) => {
      const version = await runAborting(
        ['docker', 'version', '--format', '{{json .Server.Os}} {{json .Server.Arch}}'],
        signal,
      );

      if (version.exitCode !== 0) {
        throw new Error(`docker version: ${version.stderr.trim()}`);
      }

      const [os, arch] = z.tuple([z.string(), z.string()]).parse(
        version.stdout
          .trim()
          .split(' ')
          .map((part): unknown => JSON.parse(part)),
      );

      return normalizePlatform(os, arch);
    },
    loadImage: async (image, signal) => {
      const ref = image.ref;

      const local = await readPinInspect(ref, signal);

      if (local !== null) {
        return local;
      }

      const pulled = await runAborting(['docker', 'pull', '--quiet', ref], signal);

      if (pulled.exitCode !== 0) {
        throw new ImpdError('BAD_REQUEST', {
          message: `${image.use} ${ref}: the pull failed: ${pulled.stderr.trim().slice(-FAILURE_MAX_CHARS)}`,
        });
      }

      const loaded = await readPinInspect(ref, signal);

      if (loaded === null) {
        throw new Error(`docker image inspect ${ref} failed after its pull`);
      }

      return loaded;
    },
    loadFrontend: async (signal) => {
      const inspected = await runAborting(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', DOCKERFILE_FRONTEND],
        signal,
      );

      if (inspected.exitCode === 0) {
        return;
      }

      const pulled = await runAborting(['docker', 'pull', '--quiet', DOCKERFILE_FRONTEND], signal);

      if (pulled.exitCode !== 0) {
        throw new ImpdError('BAD_GATEWAY', {
          message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: ${pulled.stderr.trim().slice(-FAILURE_MAX_CHARS)}`,
        });
      }

      getImpdLogger('image').info('pulled the Dockerfile frontend {frontend}', {
        frontend: DOCKERFILE_FRONTEND,
      });
    },
  };
}

export function toEngineRun(exec: GuestExec): EngineRun {
  return (argv, signal) => exec(argv, { signal });
}
