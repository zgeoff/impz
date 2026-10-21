import { IMAGE_BUILD_PATH, IMAGE_BUILD_STREAM_TYPE } from '@impz/api';
import type { Image, ImageBuildProgress } from '@impz/api';
import { readBuildAnswer } from './read-build-answer';
import { resolveImpdUrl } from './resolve-impd-url';

export type BuildContext = Blob | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

export interface BuildImageOptions {
  readonly dockerfile?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImageBuildProgress) => void;
  readonly onLog?: (line: string) => void;
}

export interface BuildImageDeps {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export async function runImageBuild(
  deps: Readonly<BuildImageDeps>,
  name: string,
  context: BuildContext,
  options: Readonly<BuildImageOptions> = {},
): Promise<Image> {
  const url = resolveImpdUrl(deps.baseUrl, IMAGE_BUILD_PATH);

  url.searchParams.set('name', name);

  if (options.dockerfile !== undefined) {
    url.searchParams.set('dockerfile', options.dockerfile);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-tar',
    accept: `${IMAGE_BUILD_STREAM_TYPE}, application/json`,
  };

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

  const request = new Request(url.href, init);

  const response = await (deps.fetch ?? fetch)(request);

  return readBuildAnswer(response, options.onProgress, options.onLog);
}
