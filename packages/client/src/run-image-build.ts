import { BUILD_CONTEXT_PATH, BuildContextErrorSchema, BuildContextUploadSchema } from '@impz/api';
import type { BuildContextUpload, Image, ImageBuildProgress } from '@impz/api';
import { ORPCError } from '@orpc/client';
import type { ExecDeps } from './exec/open-exec';
import { requireFeatures } from './require-features';
import { resolveImpdUrl } from './resolve-impd-url';

export type BuildContext = Blob | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

export interface BuildImageOptions {
  readonly dockerfile?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImageBuildProgress) => void;
  readonly onLog?: (line: string) => void;
}

export async function runImageBuild(
  deps: Readonly<ExecDeps>,
  name: string,
  context: BuildContext,
  options: Readonly<BuildImageOptions> = {},
): Promise<Image> {
  await requireFeatures(deps.rpc, { buildContextUpload: 'answer the upload with not found' });

  const upload = await writeBuildContext(deps, name, context, options);

  const events = await deps.rpc.images.buildStream(
    { upload: upload.id, logs: options.onLog !== undefined },
    { ...(options.signal !== undefined && { signal: options.signal }) },
  );

  for await (const event of events) {
    if (event.type === 'image') {
      return event.image;
    }

    if (event.type === 'log') {
      options.onLog?.(event.text);
    } else {
      options.onProgress?.(event);
    }
  }

  throw new ORPCError('INTERNAL_SERVER_ERROR', {
    message: 'the image build stream ended before impd answered the image',
  });
}

async function writeBuildContext(
  deps: Readonly<ExecDeps>,
  name: string,
  context: BuildContext,
  options: Readonly<BuildImageOptions>,
): Promise<BuildContextUpload> {
  const url = resolveImpdUrl(deps.baseUrl, BUILD_CONTEXT_PATH);

  url.searchParams.set('name', name);

  if (options.dockerfile !== undefined) {
    url.searchParams.set('dockerfile', options.dockerfile);
  }

  const headers: Record<string, string> = { 'content-type': 'application/x-tar' };

  if (deps.token !== null) {
    headers['authorization'] = `Bearer ${deps.token}`;
  }

  if (options.size !== undefined) {
    // impd reserves disk for the upload by its Content-Length, else by its whole limit.
    headers['content-length'] = String(options.size);
  }

  // `duplex` is in the fetch spec, but not in every RequestInit type.
  const init: RequestInit & { readonly duplex: 'half' } = {
    method: 'POST',
    headers,
    body: context,
    duplex: 'half',
    ...(options.signal !== undefined && { signal: options.signal }),
  };

  const response = await (deps.fetch ?? fetch)(new Request(url.href, init));
  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return BuildContextUploadSchema.parse(body);
  }

  const failure = BuildContextErrorSchema.safeParse(body);

  if (failure.success) {
    throw new ORPCError(failure.data.code, {
      status: response.status,
      message: failure.data.message,
    });
  }

  // A 401 comes from impd's auth before the route, without a code.
  const code = response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR';

  throw new ORPCError(code, {
    status: response.status,
    message: `impd answered ${String(response.status)} to the build context upload`,
  });
}
