import { mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_BUILD_STREAM_TYPE, ImageBuildQuerySchema } from '@impz/api';
import type { Image, ImageBuildQuery } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { checkAccess, findAccess } from '../../identity/auth/access-policy';
import type { Caller } from '../../identity/auth/caller';
import { createBuildEventStream } from '../../imps/images/build-event-stream';
import type { BuildReport, Repeat } from '../../imps/images/build-event-stream';
import type { BuildRun } from '../../imps/images/create-build-runs';
import type { ImageService } from '../../imps/images/image-service';
import type { ApiAudit } from '../../platform/audit/api-audit';
import type { ImageRecord } from '../../platform/db/images';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { buildUploadsDir } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { SurfaceConfig } from '../surface-config';
import { toORPCError } from '../to-orpc-error';

const PROCEDURE = 'images.build';

export interface BuildContextRoute {
  readonly respond: (
    request: Request,
    caller: Readonly<Caller>,
    toApi: (image: ImageRecord) => Image,
  ) => Promise<Response>;
}

export interface BuildContextDeps {
  readonly config: Pick<SurfaceConfig, 'dataDir' | 'buildContextMaxBytes'>;
  readonly images: Pick<ImageService, 'buildImageFromContext' | 'claimBuildSlot' | 'startBuildRun'>;
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly audit: ApiAudit;
  readonly now: () => number;
  readonly keepaliveMs: number;
  readonly repeat?: Repeat;
}

interface BuildFailure {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type BuildOutcome =
  | { readonly ok: true; readonly image: Image }
  | { readonly ok: false; readonly failure: BuildFailure };

interface RunBuildOptions {
  readonly request: Request;
  readonly query: ImageBuildQuery;
  readonly limitBytes: number;
  readonly signal: AbortSignal;
  readonly report: Readonly<BuildReport>;
  readonly setBuilder: (name: string) => void;
}

export function createBuildContextRoute(deps: BuildContextDeps): BuildContextRoute {
  const uploadsDir = buildUploadsDir(deps.config.dataDir);

  rmSync(uploadsDir, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const runBuild = async (options: RunBuildOptions): Promise<ImageRecord> => {
    const limitBytes = options.limitBytes;
    const signal = options.signal;
    const report = options.report;
    const tarPath = join(uploadsDir, `${Bun.randomUUIDv7()}.tar`);

    try {
      return await deps.diskBudget.withRoom(limitBytes, async () => {
        await writeBody(options.request, tarPath, limitBytes, deps.config.buildContextMaxBytes);

        signal.throwIfAborted();
        report.setPhase('build');

        return deps.images.buildImageFromContext(
          tarPath,
          options.query.name,
          options.query.dockerfile,
          {
            signal,
            setPhase: report.setPhase,
            output: report.output,
            setBuilder: options.setBuilder,
          },
        );
      });
    } finally {
      rmSync(tarPath, { force: true });
    }
  };

  return {
    respond: async (request, caller, toApi) => {
      const startedAt = deps.now();
      const params = Object.fromEntries(new URL(request.url).searchParams);
      const parsed = ImageBuildQuerySchema.safeParse(params);

      const denial = await checkAccess(findAccess(PROCEDURE), caller, params, readNoSecret);

      const writeFailure = (error: unknown): BuildFailure => {
        deps.audit.record({ procedure: PROCEDURE, actor: caller, impName: null, startedAt }, error);

        const mapped = toORPCError(error);

        const known =
          mapped instanceof ORPCError
            ? mapped
            : new ORPCError('INTERNAL_SERVER_ERROR', { message: getErrorMessage(error) });

        return { code: String(known.code), message: known.message, status: known.status };
      };

      const sendFailure = (error: unknown): Response => sendError(writeFailure(error));

      if (denial !== null) {
        return sendFailure(new ORPCError('FORBIDDEN', { message: denial.message }));
      }

      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');

        return sendFailure(new ORPCError('BAD_REQUEST', { message }));
      }

      // A refusal must answer with its real status before a stream answers 200.
      let reserved: {
        readonly limitBytes: number;
        readonly run: BuildRun;
        readonly release: () => void;
      };

      try {
        const limitBytes = readLimit(request, deps.config.buildContextMaxBytes);
        const releaseSlot = deps.images.claimBuildSlot();
        const run = deps.images.startBuildRun(parsed.data.name, 'upload');

        reserved = {
          limitBytes,
          run,
          release: () => {
            run.end();

            releaseSlot();
          },
        };
      } catch (error) {
        return sendFailure(error);
      }

      const runToOutcome = async (
        signal: AbortSignal,
        report: Readonly<BuildReport>,
      ): Promise<BuildOutcome> => {
        const run = reserved.run;

        const tracked: BuildReport = {
          setPhase: (phase) => {
            run.setPhase(phase);
            report.setPhase(phase);
          },
          output: {
            emitLog: report.output.emitLog,
            setStep: (step) => {
              run.setStep(step);
              report.output.setStep(step);
            },
          },
        };

        try {
          const image = await runBuild({
            request,
            query: parsed.data,
            limitBytes: reserved.limitBytes,
            signal,
            report: tracked,
            setBuilder: run.setBuilder,
          });

          deps.audit.record(
            { procedure: PROCEDURE, actor: caller, impName: null, startedAt },
            null,
          );

          return { ok: true, image: toApi(image) };
        } catch (error) {
          if (!(toORPCError(error) instanceof ORPCError) && !signal.aborted) {
            getImpdLogger('image').error('image build from an upload failed: {error}', { error });
          }

          return { ok: false, failure: writeFailure(error) };
        } finally {
          reserved.release();
        }
      };

      if (isStreamAccepted(request)) {
        return createBuildEventStream(
          request.signal,
          async (signal, report) => {
            const outcome = await runToOutcome(signal, report);

            return outcome.ok
              ? { type: 'image', image: outcome.image }
              : { type: 'error', code: outcome.failure.code, message: outcome.failure.message };
          },
          {
            keepaliveMs: deps.keepaliveMs,
            now: deps.now,
            ...(deps.repeat !== undefined && { repeat: deps.repeat }),
          },
        );
      }

      const outcome = await runToOutcome(request.signal, {
        setPhase: () => {},
        output: { emitLog: () => {}, setStep: () => {} },
      });

      return outcome.ok ? Response.json(outcome.image) : sendError(outcome.failure);
    },
  };
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

function isStreamAccepted(request: Request): boolean {
  return request.headers.get('accept')?.includes(IMAGE_BUILD_STREAM_TYPE) === true;
}
