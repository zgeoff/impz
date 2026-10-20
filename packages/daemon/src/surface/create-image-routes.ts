import type { ImageBuildPhase } from '@impz/api';
import { runImageOp } from '../imps/images/image-op-stream';
import type { ImageOpStreamOptions } from '../imps/images/image-op-stream';
import { findImpName } from '../platform/audit/api-audit';
import { mergeSignals } from '../platform/process/merge-signals';
import type { AuditDetail, RpcContext, RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';
import { toApiImage } from './to-api-image';

// `images.*`: pulls, builds and templates
export function createImageRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    list: os.images.list.handler(async () => {
      const images = await deps.images.listImages();

      return images.map((image) => toApiImage(image));
    }),

    // a client that goes, or whose token ends, ends a pull and its builder
    add: os.images.add.handler(async (context) => {
      const input = context.input;
      const signal = mergeSignals(context.signal, context.context.ends);

      // the reference the pull resolved goes in the audit row
      const onResolved = (reference: string): void => {
        context.context.auditDetail.value = reference;
      };

      const image =
        'imp' in input
          ? await deps.templates.createTemplate(input.imp, input.name)
          : await deps.images.addImage(input.ref, input.name, { signal, onResolved });

      return toApiImage(image);
    }),
    addStream: os.images.addStream.handler((context) => {
      const input = context.input;
      const firstPhase = 'imp' in input ? 'copy' : 'pull';

      // the reference the pull resolved goes in the audit row, as for add
      const onResolved = (reference: string): void => {
        context.context.auditDetail.value = reference;
      };

      return runImageOp(
        async (signal, report) => {
          // a template copies an imp's disk under its lock: no client
          // stops it, as with images.add
          const image =
            'imp' in input
              ? await deps.templates.createTemplate(input.imp, input.name)
              : await deps.images.addImage(input.ref, input.name, {
                  signal,
                  setPhase: report.setPhase,
                  onResolved,
                });

          return toApiImage(image);
        },
        buildImageOpOptions(deps, context, 'images.addStream', firstPhase),
      );
    }),
    buildStream: os.images.buildStream.handler((context) =>
      runImageOp(
        async (signal, report) => {
          const image = await deps.images.runImageBuild(
            context.input.contextDir,
            context.input.name,
            context.input.dockerfile,
            { signal, setPhase: report.setPhase, output: report.output },
          );

          return toApiImage(image);
        },
        {
          ...buildImageOpOptions(deps, context, 'images.buildStream', 'pack'),
          logs: context.input.logs === true,
        },
      ),
    ),
    builds: os.images.builds.handler(() => deps.images.listBuildRuns()),
    build: os.images.build.handler(async (context) => {
      // a client that goes stops the build on the engine, which may run
      // past any fetch limit
      const image = await deps.images.runImageBuild(
        context.input.contextDir,
        context.input.name,
        context.input.dockerfile,
        { ...(context.signal !== undefined && { signal: context.signal }) },
      );

      return toApiImage(image);
    }),
    delete: os.images.delete.handler(async (context) => {
      await deps.images.removeImage(context.input.name);

      return {};
    }),
  };
}

// what a streamed image call's options are made from
interface ImageOpCall {
  readonly context: RpcContext & { readonly auditDetail: Readonly<AuditDetail> };
  readonly input: unknown;
  readonly signal?: AbortSignal | undefined;
}

// A streamed image call audits itself as its work ends, so the row holds
// the outcome rather than the stream's opening (access-policy.ts)
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
