import { mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { BuildContextQuerySchema, callerContract } from '@impz/api';
import type { BuildContextQuery } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import { checkAccess, findDeclaredAccess } from '../../identity/auth/access-policy';
import type { AccessReaders } from '../../identity/auth/access-policy';
import type { BuildRun } from '../../imps/images/build/create-build-runs';
import type { ImageService } from '../../imps/images/image-service';
import type { ApiAudit } from '../../platform/audit/api-audit';
import { ImpdError } from '../../platform/errors/impd-error';
import type { Caller } from '../../platform/principal/caller';
import type { StartTimer } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { buildUploadsDir } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { SurfaceConfig } from '../surface-config';
import { toORPCError } from '../to-orpc-error';
import { buildUploadMachine } from './build-upload-machine';

const PROCEDURE = 'images.buildStream';
const BUILD_ACCESS = findDeclaredAccess(callerContract.images.buildStream['~orpc'].meta);
const NO_READS: AccessReaders = { readSecretGeneration: readNoSecret, readImage: readNoImage };

// A client follows its upload with the build at once, so a context still here after this long
// has lost its client.
/* @internal */
export const UPLOAD_TTL_MS = 5 * 60_000;

interface BuildUpload {
  readonly tarPath: string;
  readonly query: BuildContextQuery;
  readonly run: BuildRun;
  readonly release: () => void;
}

export interface BuildContextRoute {
  readonly respond: (request: Request, caller: Readonly<Caller>) => Promise<Response>;
  readonly takeUpload: (id: string, caller: Readonly<Caller>) => BuildUpload;
  readonly releaseUploads: () => void;
}

export interface BuildContextDeps {
  readonly config: Pick<SurfaceConfig, 'dataDir' | 'buildContextMaxBytes'>;
  readonly images: Pick<ImageService, 'claimBuildSlot' | 'startBuildRun'>;
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly audit: ApiAudit;
  readonly now: () => number;
  readonly startTimer: StartTimer;
}

interface HeldUpload {
  readonly upload: BuildUpload;
  readonly owner: string;
  readonly actor: Actor<typeof buildUploadMachine>;
}

interface BuildFailure {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export function createBuildContextRoute(deps: BuildContextDeps): BuildContextRoute {
  const uploadsDir = buildUploadsDir(deps.config.dataDir);

  const clock = {
    setTimeout: (fire: () => void, durationMs: number) => deps.startTimer(fire, durationMs),
    clearTimeout: (stop: unknown) => {
      if (isStopTimer(stop)) {
        stop();
      }
    },
  };

  const held = new Map<string, HeldUpload>();

  rmSync(uploadsDir, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const writeUpload = async (
    request: Request,
    query: BuildContextQuery,
    caller: Readonly<Caller>,
  ): Promise<{ readonly id: string; readonly expiresAt: Date }> => {
    const limitBytes = readLimit(request, deps.config.buildContextMaxBytes);
    const releaseSlot = deps.images.claimBuildSlot();
    const run = deps.images.startBuildRun(query.name, 'upload');
    const id = Bun.randomUUIDv7();
    const tarPath = join(uploadsDir, `${id}.tar`);
    const stored = Promise.withResolvers<void>();
    const freed = Promise.withResolvers<void>();

    const release = (): void => {
      freed.resolve();

      try {
        rmSync(tarPath, { force: true });
      } catch (error) {
        getImpdLogger('image').warning('build context {path} not removed: {error}', {
          path: tarPath,
          error: getErrorMessage(error),
        });
      }

      run.end();

      releaseSlot();
    };

    const holding = deps.diskBudget.withRoom(limitBytes, async () => {
      await writeBody(request, tarPath, limitBytes, deps.config.buildContextMaxBytes);

      stored.resolve();

      await freed.promise;
    });

    try {
      await Promise.race([stored.promise, holding]);
    } catch (error) {
      release();
      throw error;
    }

    const expiresAt = deps.now() + UPLOAD_TTL_MS;

    const actor = createActor(buildUploadMachine, {
      input: {
        ttlMs: UPLOAD_TTL_MS,
        free: () => {
          held.delete(id);

          release();
        },
      },
      clock,
    });

    const upload = {
      tarPath,
      query,
      run,
      release: () => {
        actor.send({ type: 'release' });
      },
    };

    held.set(id, { upload, owner: toOwner(caller), actor });
    actor.start();

    return { id, expiresAt: new Date(expiresAt) };
  };

  return {
    respond: async (request, caller) => {
      const startedAt = deps.now();
      const params = Object.fromEntries(new URL(request.url).searchParams);

      const sendFailure = (error: unknown): Response => {
        deps.audit.record({ procedure: PROCEDURE, actor: caller, impName: null, startedAt }, error);

        return sendError(toFailure(error));
      };

      const denial = await checkAccess(BUILD_ACCESS, caller, params, NO_READS);

      if (denial !== null) {
        return sendFailure(new ORPCError('FORBIDDEN', { message: denial.message }));
      }

      const parsed = BuildContextQuerySchema.safeParse(params);

      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');

        return sendFailure(new ORPCError('BAD_REQUEST', { message }));
      }

      try {
        const upload = await writeUpload(request, parsed.data, caller);

        return Response.json(upload, { status: 201 });
      } catch (error) {
        if (!(toORPCError(error) instanceof ORPCError) && !request.signal.aborted) {
          getImpdLogger('image').error('build context upload failed: {error}', {
            error: getErrorMessage(error),
          });
        }

        return sendFailure(error);
      }
    },
    takeUpload: (id, caller) => {
      const entry = held.get(id);

      if (entry?.owner !== toOwner(caller)) {
        throw new ImpdError('NOT_FOUND', {
          message: `build context upload ${id} not found; upload the context again`,
        });
      }

      held.delete(id);
      entry.actor.send({ type: 'take' });

      return entry.upload;
    },
    releaseUploads: () => {
      for (const entry of held.values()) {
        entry.actor.send({ type: 'stop' });
      }
    },
  };
}

function isStopTimer(value: unknown): value is () => void {
  return typeof value === 'function';
}

function toOwner(caller: Readonly<Caller>): string {
  return JSON.stringify([caller.kind, caller.name, caller.tokenId, caller.grantId]);
}

function toFailure(error: unknown): BuildFailure {
  const mapped = toORPCError(error);

  const known =
    mapped instanceof ORPCError
      ? mapped
      : new ORPCError('INTERNAL_SERVER_ERROR', { message: getErrorMessage(error) });

  return { code: String(known.code), message: known.message, status: known.status };
}

async function writeBody(
  request: Request,
  path: string,
  limitBytes: number,
  maxBytes: number,
): Promise<void> {
  if (request.body === null) {
    throw new ORPCError('BAD_REQUEST', { message: 'the build context is missing: send a tar' });
  }

  const file = await open(path, 'wx', 0o600);

  let written = 0;

  try {
    for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
      written += chunk.byteLength;

      if (written > maxBytes) {
        throw buildTooLargeError(maxBytes);
      }

      if (written > limitBytes) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'the body is longer than its Content-Length',
        });
      }

      await file.write(chunk);
    }
  } finally {
    await file.close();
  }

  if (written === 0) {
    throw new ORPCError('BAD_REQUEST', { message: 'the build context is empty: send a tar' });
  }
}

function buildTooLargeError(maxBytes: number): ORPCError<string, unknown> {
  const mib = String(Math.floor(maxBytes / 1024 ** 2));

  return new ORPCError('PAYLOAD_TOO_LARGE', {
    message: `the build context is larger than the limit, ${mib} MiB (IMP_BUILD_CONTEXT_MAX_MIB)`,
  });
}

function readNoSecret(): Promise<null> {
  return Promise.resolve(null);
}

function readNoImage(): Promise<undefined> {
  return Promise.resolve(undefined);
}

function sendError(failure: BuildFailure): Response {
  return Response.json(
    { code: failure.code, message: failure.message },
    { status: failure.status },
  );
}

// A Content-Length can only lower the limit, because a client can send more
// than it declared; the body's bytes are counted as they come.
function readLimit(request: Request, maxBytes: number): number {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);

  if (!Number.isSafeInteger(declared) || declared < 0) {
    return maxBytes;
  }

  if (declared > maxBytes) {
    throw buildTooLargeError(maxBytes);
  }

  return declared;
}
