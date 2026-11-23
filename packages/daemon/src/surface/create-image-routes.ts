import type { Image, ImageBuildPhase } from '@impz/api';
import { getErrorMessage } from '@impz/shared';
import { ORPCError } from '@orpc/server';
import invariant from 'tiny-invariant';
import { runImageOp } from '../imps/images/build/run-image-op';
import type { ImageOpStreamOptions } from '../imps/images/build/run-image-op';
import { findImpName } from '../platform/audit/api-audit';
import type { ImageRecord } from '../platform/db/create-image';
import { ImpdError } from '../platform/errors/impd-error';
import { mergeSignals } from '../platform/process/merge-signals';
import type { AuditDetail, RpcContext, RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';
import { toApiImage } from './to-api-image';

export function createImageRoutes(os: RpcImplementer, deps: RouterDeps) {
  const readApiImage = async (image: ImageRecord): Promise<Image> => {
    const aliases = await deps.images.listImageAliases([image.id]);

    return toApiImage(image, aliases.get(image.id) ?? []);
  };

  return {
    list: os.images.list.handler(async () => {
      const images = await deps.images.listImages();
      const aliases = await deps.images.listImageAliases(images.map((image) => image.id));

      return images.map((image) => toApiImage(image, aliases.get(image.id) ?? []));
    }),
    add: os.images.add.handler(async (context) => {
      const input = context.input;
      const signal = mergeSignals(context.signal, context.context.ends);

      const onResolved = (reference: string): void => {
        context.context.auditDetail.value = reference;
      };

      const image =
        'imp' in input
          ? await deps.templates.createTemplate(input.imp, input.name)
          : await deps.images.addImage(input.ref, input.name, { signal, onResolved });

      return readApiImage(image);
    }),
    addStream: os.images.addStream.handler((context) => {
      const input = context.input;
      const firstPhase = 'imp' in input ? 'copy' : 'pull';

      const onResolved = (reference: string): void => {
        context.context.auditDetail.value = reference;
      };

      return runImageOp(
        async (signal, report) => {
          const image =
            'imp' in input
              ? await deps.templates.createTemplate(input.imp, input.name)
              : await deps.images.addImage(input.ref, input.name, {
                  signal,
                  setPhase: report.setPhase,
                  onResolved,
                });

          return readApiImage(image);
        },
        buildImageOpOptions(deps, context, 'images.addStream', firstPhase),
      );
    }),
    buildStream: os.images.buildStream.handler((context) => {
      const input = context.input;
      const logs = input.logs === true;

      if ('upload' in input) {
        return runImageOp(
          makeShownFailureRun(async (signal, report) => {
            const upload = deps.buildContexts.takeUpload(input.upload, context.context.caller);
            const run = upload.run;

            context.context.auditDetail.value = upload.query.name;

            run.setPhase('build');

            try {
              const image = await deps.images.buildImageFromContext(
                upload.tarPath,
                upload.query.name,
                upload.query.dockerfile,
                {
                  signal,
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
                  setBuilder: run.setBuilder,
                },
              );

              return readApiImage(image);
            } finally {
              upload.release();
            }
          }),
          { ...buildImageOpOptions(deps, context, 'images.buildStream', 'build'), logs },
        );
      }

      return runImageOp(
        makeShownFailureRun(async (signal, report) => {
          const image = await deps.images.runImageBuild(
            input.contextDir,
            input.name,
            input.dockerfile,
            {
              signal,
              setPhase: report.setPhase,
              output: report.output,
            },
          );

          return readApiImage(image);
        }),
        { ...buildImageOpOptions(deps, context, 'images.buildStream', 'pack'), logs },
      );
    }),
    builds: os.images.builds.handler(() => deps.images.listBuildRuns()),
    build: os.images.build.handler(async (context) => {
      const image = await deps.images.runImageBuild(
        context.input.contextDir,
        context.input.name,
        context.input.dockerfile,
        { ...(context.signal !== undefined && { signal: context.signal }) },
      );

      return readApiImage(image);
    }),
    delete: os.images.delete.handler(async (context) => {
      await deps.images.removeImage(context.input.name);

      return {};
    }),
    pin: os.images.pin.handler(async (context) => {
      const image = await deps.images.updateImagePin(
        context.input.name,
        true,
        findPinRefPrefix(context.context.caller),
      );

      return readApiImage(image);
    }),
    unpin: os.images.unpin.handler(async (context) => {
      const image = await deps.images.updateImagePin(
        context.input.name,
        false,
        findPinRefPrefix(context.context.caller),
      );

      return readApiImage(image);
    }),
    alias: os.images.alias.handler(async (context) => {
      const image = await deps.images.updateImageAlias(context.input.alias, context.input.image);

      return readApiImage(image);
    }),
    unalias: os.images.unalias.handler(async (context) => {
      await deps.images.removeImageAlias(context.input.alias);

      return {};
    }),
  };
}

interface ImageOpCall {
  readonly context: RpcContext & { readonly auditDetail: Readonly<AuditDetail> };
  readonly input: unknown;
  readonly signal?: AbortSignal | undefined;
}

function buildImageOpOptions(
  deps: RouterDeps,
  call: Readonly<ImageOpCall>,
  procedure: string,
  firstPhase: ImageBuildPhase,
): ImageOpStreamOptions {
  const startedAt = deps.now();

  return {
    firstPhase,
    signal: call.signal ?? new AbortController().signal,
    keepaliveMs: deps.imageKeepaliveMs,
    ...(deps.imageKeepaliveRepeat !== undefined && { repeat: deps.imageKeepaliveRepeat }),
    now: deps.now,
    record: (failure) => {
      const impName = findImpName(procedure, call.input, null);

      deps.audit.record(
        {
          procedure,
          actor: call.context.caller,
          impName,
          startedAt,
          detail: call.context.auditDetail.value,
        },
        failure,
      );
    },
  };
}

type ImageOpRun = Parameters<typeof runImageOp>[0];

// oRPC answers an error it does not know with a bare "Internal server error", and a build
// client needs the reason, such as a builder out of disk.
function makeShownFailureRun(run: ImageOpRun): ImageOpRun {
  return async (signal, report) => {
    try {
      return await run(signal, report);
    } catch (error) {
      if (error instanceof ImpdError || error instanceof ORPCError) {
        throw error;
      }

      throw new ImpdError('INTERNAL_SERVER_ERROR', {
        message: getErrorMessage(error),
        cause: error,
      });
    }
  };
}

// the access check passed on the held image's ref, and the pin itself checks the ref
// again, so an image replaced between the two never takes a scoped caller's pin
function findPinRefPrefix(caller: Readonly<RpcContext['caller']>): string | null {
  if (caller.imps === null) {
    return null;
  }

  invariant(caller.imageRefPrefix !== null, 'a scoped pin without a prefix passed its check');

  return caller.imageRefPrefix;
}
