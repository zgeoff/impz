import { P, match } from 'ts-pattern';
import { z } from 'zod';
import { formatEngineFailure, formatRefusal } from './refusal';
import { formatQuery, getRequestRoute } from './router';
import type { RoutedRequest } from './router';
import {
  BUILD_CONTENT_TYPE,
  checkBuildContentType,
  checkBuildQuery,
  checkCreateBody,
  checkNoQuery,
  checkPullQuery,
  checkRemoveQuery,
} from './rules';
import type { Check } from './rules';

export const PROXY_LABEL = 'imp.docker-proxy';
const CONTROL_CALL_MS = 120_000;
const CREATE_BODY_MAX_BYTES = 1024 ** 2;

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

const LabelsSchema = z.record(z.string(), z.string()).nullish();

export const ContainerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/v),
  Config: z.object({ Labels: LabelsSchema }),
});

export interface DockerProxyOptions {
  readonly upstreamSocket: string;
  readonly token: string;
  readonly hostImage: string;
  readonly builderImage: string | null;
  readonly buildContextMaxBytes: number;
  readonly log: (message: string) => void;
  readonly controlCallMs?: number;
}

class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

function buildJsonResponse(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

async function readBodyWithin(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  if (request.body === null) {
    return new Uint8Array();
  }

  for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;

    if (total > maxBytes) {
      return null;
    }

    chunks.push(chunk);
  }

  return Bun.concatArrayBuffers(chunks, Infinity, true);
}

function createByteLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;

  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;

      if (total > maxBytes) {
        controller.error(
          new BodyTooLargeError(`the build context is larger than ${String(maxBytes)} bytes`),
        );

        return;
      }

      controller.enqueue(chunk);
    },
  });
}

function pickHeaders(request: Request, names: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const name of names) {
    const value = request.headers.get(name);

    if (value !== null) {
      headers[name] = value;
    }
  }

  return headers;
}

function toClientResponse(upstream: Response): Response {
  const headers = new Headers();

  for (const [name, value] of upstream.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) {
      headers.append(name, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

interface UpstreamCall {
  readonly method: string;
  readonly path: string;
  readonly query?: ReadonlyMap<string, readonly string[]>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | ReadableStream<Uint8Array> | null;

  // Bun's fetch gives up on an answer that stays silent for 360 s, which a quiet RUN step outlasts.
  readonly longRunning?: { readonly signal: AbortSignal };
}

export function createDockerProxy(
  options: DockerProxyOptions,
): (request: Request) => Promise<Response> {
  const sendUpstream = (versionPrefix: string, call: UpstreamCall): Promise<Response> => {
    const search = call.query === undefined ? '' : formatQuery(call.query);

    return fetch(`http://docker${versionPrefix}${call.path}${search}`, {
      method: call.method,
      headers: call.headers ?? {},
      body: call.body ?? null,
      unix: options.upstreamSocket,
      duplex: 'half',
      redirect: 'manual',
      decompress: false,
      ...(call.longRunning === undefined
        ? { signal: AbortSignal.timeout(options.controlCallMs ?? CONTROL_CALL_MS) }
        : { timeout: false, signal: call.longRunning.signal }),
    });
  };

  const sendAndRelay = async (versionPrefix: string, call: UpstreamCall): Promise<Response> => {
    const upstream = await sendUpstream(versionPrefix, call);

    return toClientResponse(upstream);
  };

  const buildRefusal = (request: Request, path: string, reason: string): Response => {
    options.log(`refused ${request.method} ${path}: ${reason}`);

    return buildJsonResponse(403, formatRefusal(reason));
  };

  const readOwnContainer = async (versionPrefix: string, id: string): Promise<string | null> => {
    const inspected = await sendUpstream(versionPrefix, {
      method: 'GET',
      path: `/containers/${id}/json`,
    });

    if (!inspected.ok) {
      await inspected.body?.cancel();

      return null;
    }

    const body: unknown = await inspected.json();

    const container = ContainerSchema.safeParse(body);

    if (!container.success || container.data.Config.Labels?.[PROXY_LABEL] !== options.token) {
      return null;
    }

    return container.data.Id;
  };

  const handleCreate = async (
    request: Request,
    versionPrefix: string,
    path: string,
  ): Promise<Response> => {
    const raw = await readBodyWithin(request, CREATE_BODY_MAX_BYTES);

    if (raw === null) {
      return buildRefusal(
        request,
        path,
        `the create body is larger than ${String(CREATE_BODY_MAX_BYTES)} bytes`,
      );
    }

    let body: unknown = null;

    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return buildRefusal(request, path, 'the create body is not JSON');
    }

    const checked = checkCreateBody(body, options.hostImage, options.builderImage);

    if (!checked.isOk || checked.image === undefined) {
      const reason = checked.isOk ? 'Image is missing' : checked.reason;

      return buildRefusal(request, path, reason);
    }

    const created = JSON.stringify({
      Image: checked.image,
      Cmd: ['/bin/true'],
      Labels: { [PROXY_LABEL]: options.token },
      HostConfig: { NetworkMode: 'none', RestartPolicy: { Name: 'no' } },
    });

    return sendAndRelay(versionPrefix, {
      method: 'POST',
      path: '/containers/create',
      headers: { 'content-type': 'application/json' },
      body: created,
    });
  };

  const handleBuild = async (
    request: Request,
    routed: RoutedRequest,
    path: string,
  ): Promise<Response> => {
    const contentType = checkBuildContentType(request.headers.get('content-type'));

    if (!contentType.isOk) {
      return buildRefusal(request, path, contentType.reason);
    }

    const limit = createByteLimit(options.buildContextMaxBytes);
    const body = request.body === null ? null : request.body.pipeThrough(limit);

    try {
      return await sendAndRelay(routed.versionPrefix, {
        method: 'POST',
        path: '/build',
        query: routed.query,

        headers: { 'content-type': BUILD_CONTENT_TYPE },
        body,
        longRunning: { signal: request.signal },
      });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return buildJsonResponse(
          413,
          formatRefusal(`${error.message} (IMP_BUILD_CONTEXT_MAX_MIB)`),
        );
      }

      throw error;
    }
  };

  const handlePull = async (
    request: Request,
    routed: RoutedRequest,
    path: string,
  ): Promise<Response> => {
    const raw = await readBodyWithin(request, 0);

    if (raw === null) {
      return buildRefusal(request, path, 'a pull takes no body');
    }

    const query = new Map([['fromImage', routed.query.get('fromImage') ?? []]]);

    const tag = routed.query.get('tag');

    if (tag !== undefined) {
      query.set('tag', tag);
    }

    return sendAndRelay(routed.versionPrefix, {
      method: 'POST',
      path: '/images/create',
      query,
      headers: pickHeaders(request, ['x-registry-auth']),
      longRunning: { signal: request.signal },
    });
  };

  const handleOwnContainer = async (
    request: Request,
    versionPrefix: string,
    path: string,
    id: string,
  ): Promise<Response> => {
    const fullId = await readOwnContainer(versionPrefix, id);

    if (fullId === null) {
      return buildRefusal(request, path, `container ${id} was not created by this proxy`);
    }

    if (request.method === 'DELETE') {
      const query = new Map([
        ['force', ['1']],
        ['v', ['1']],
      ]);

      return sendAndRelay(versionPrefix, {
        method: 'DELETE',
        path: `/containers/${fullId}`,
        query,
      });
    }

    return sendAndRelay(versionPrefix, {
      method: 'GET',
      path: `/containers/${fullId}/export`,
      longRunning: { signal: request.signal },
    });
  };

  const checkRouteQuery = (routed: RoutedRequest): Check => {
    const kind = routed.route.kind;

    if (kind === 'build' && options.builderImage !== null) {
      return {
        isOk: false,
        reason: 'a build is refused: under IMP_BUILD_ISOLATION=imp impd builds in builder imps',
      };
    }

    if (kind === 'build') {
      return checkBuildQuery(routed.query);
    }

    if (kind === 'pull') {
      return checkPullQuery(routed.query, options.hostImage, options.builderImage);
    }

    if (kind === 'remove') {
      return checkRemoveQuery(routed.query);
    }

    return checkNoQuery(routed.query);
  };

  const handleRouted = (
    request: Request,
    routed: RoutedRequest,
    path: string,
  ): Promise<Response> | Response => {
    const checked = checkRouteQuery(routed);

    if (!checked.isOk) {
      return buildRefusal(request, path, checked.reason);
    }

    const prefix = routed.versionPrefix;

    return match(routed.route)
      .returnType<Promise<Response> | Response>()
      .with({ kind: 'ping' }, () =>
        sendAndRelay(prefix, { method: request.method, path: '/_ping' }),
      )
      .with({ kind: 'version' }, () => sendAndRelay(prefix, { method: 'GET', path: '/version' }))
      .with({ kind: 'image-inspect' }, (inspect) =>
        sendAndRelay(prefix, { method: 'GET', path: `/images/${inspect.name}/json` }),
      )
      .with({ kind: 'pull' }, () => handlePull(request, routed, path))
      .with({ kind: 'build' }, () => handleBuild(request, routed, path))
      .with({ kind: 'create' }, () => handleCreate(request, prefix, path))
      .with({ kind: P.union('export', 'remove') }, (owned) =>
        handleOwnContainer(request, prefix, path, owned.id),
      )
      .exhaustive();
  };

  return async (request) => {
    const url = new URL(request.url);

    const routed = getRequestRoute(request.method, `${url.pathname}${url.search}`);

    if (!routed.isAllowed) {
      return buildRefusal(request, url.pathname, routed.reason);
    }

    // The engine hijacks an Upgrade connection into a raw stream, as attach and a BuildKit
    // session do.
    if (request.headers.has('upgrade')) {
      return buildRefusal(request, url.pathname, 'an Upgrade request is not a call impd makes');
    }

    try {
      return await handleRouted(request, routed.request, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      options.log(`error on ${request.method} ${url.pathname}: ${message}`);

      return buildJsonResponse(502, formatEngineFailure(message));
    }
  };
}
