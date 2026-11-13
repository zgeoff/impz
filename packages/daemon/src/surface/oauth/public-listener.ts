import { MCP_PATH } from '@impz/api';
import invariant from 'tiny-invariant';
import type { ImpdMcpAuth } from '../../identity/oauth/create-impd-mcp-auth';
import type { PublicMcpConfig } from '../../identity/oauth/public-mcp-config';
import { readBodyText } from '../../identity/oauth/read-body-text';
import type { Caller } from '../../platform/principal/caller';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { startRealTimer } from '../../platform/process/start-real-timer';
import { tapStream } from '../../platform/process/tap-stream';
import { createPublicApp } from './create-public-app';
import { keepStreamVerified } from './keep-stream-verified';

const MAX_OPEN = 64;
const MAX_CONTROL = 16;
const MAX_CONTROL_BYTES = 16 * 1024;

// A JSON-RPC message carries a file write's content, 4 MiB as text.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDLE_TIMEOUT_S = 30;

// An access token lives 15 minutes, so an open stream checks its token again before then.
const REVERIFY_MS = 10 * 60_000;

export interface PublicMcpTransport {
  readonly respond: (request: Request, caller: Readonly<Caller>) => Promise<Response>;
  readonly close: () => Promise<void>;

  // Settles when the tool call ends, which neither a dropped stream nor an aborted request
  // hastens.
  readonly readCallEnd: (response: Response) => Promise<void> | null;
}

export interface PublicListenerDeps {
  readonly config: PublicMcpConfig;
  readonly oauth: Pick<ImpdMcpAuth, 'server' | 'readCaller'>;
  readonly mcp: PublicMcpTransport;

  // how often an open MCP stream checks its access token again
  readonly reverifyMs?: number;
}

type PublicServer = Pick<Bun.Server<undefined>, 'timeout' | 'requestIP'>;

export interface PublicListener {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/* @internal */
export function createPublicHandler(
  deps: Readonly<PublicListenerDeps>,
): (request: Request, server: PublicServer | null) => Promise<Response> {
  const state = { open: 0, control: 0 };

  const servers = new WeakMap<Request, PublicServer>();

  const auth = deps.oauth.server;

  invariant(auth !== null, 'the public listener starts only with the public MCP route set');

  const app = createPublicApp({
    auth,
    host: deps.config.host,
    readCaller: deps.oauth.readCaller,
    readRequester: (request) => ({
      socketAddress: servers.get(request)?.requestIP(request)?.address ?? null,
      connectingIP: null,
      userAgent: request.headers.get('user-agent'),
    }),

    // A tool call can run for minutes, so no idle timeout ends it.
    respond: (request, caller) => {
      servers.get(request)?.timeout(request, 0);

      return deps.mcp.respond(request, caller);
    },
  });

  const handleRequest = (request: Request, server: PublicServer | null): Promise<Response> => {
    if (server !== null) {
      servers.set(request, server);
    }

    return app.handle(request);
  };

  const handleControl = async (request: Request): Promise<Response> => {
    if (state.control >= MAX_CONTROL) {
      return buildTooMany();
    }

    state.control += 1;

    try {
      const control = await readControlRequest(request);

      return control === null ? buildTooMany() : await handleRequest(control, null);
    } finally {
      state.control -= 1;
    }
  };

  return async (request, server) => {
    if (state.open >= MAX_OPEN) {
      return handleControl(request);
    }

    state.open += 1;

    const release = createRelease(() => {
      state.open -= 1;
    });

    try {
      const response = await handleRequest(request, server);

      const held = holdUntilDone(request, response, deps.mcp.readCallEnd(response), release);

      return keepVerified(request, held, {
        verify: auth.verify,
        everyMs: deps.reverifyMs ?? REVERIFY_MS,
      });
    } catch (error) {
      release();
      throw error;
    }
  };
}

interface Reverify {
  readonly verify: (bearer: string) => Promise<unknown>;
  readonly everyMs: number;
}

function keepVerified(
  request: Request,
  response: Response,
  reverify: Readonly<Reverify>,
): Response {
  // The shared adapter reads the scheme in any case, so a stream it let through under `bearer`
  // must be checked too.
  const bearer = /^Bearer (?<token>\S+)$/iv.exec(request.headers.get('authorization') ?? '')
    ?.groups?.['token'];

  const isStream = response.headers.get('content-type')?.startsWith('text/event-stream') ?? false;

  if (bearer === undefined || response.body === null || !isStream) {
    return response;
  }

  const body = keepStreamVerified(response.body, {
    probeToken: async () => {
      const access = await reverify.verify(bearer);

      return access !== null;
    },
    everyMs: reverify.everyMs,
    startTimer: startRealTimer,
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createRelease(release: () => void): () => void {
  const state = { isReleased: false };

  return () => {
    if (!state.isReleased) {
      state.isReleased = true;

      release();
    }
  };
}

// MCP treats a dropped stream as no cancel, so a tool call runs on and keeps
// its slot until the tool ends.
async function waitThenRelease(callEnd: Promise<void>, release: () => void): Promise<void> {
  try {
    await callEnd;
  } finally {
    release();
  }
}

function holdUntilDone(
  request: Request,
  response: Response,
  callEnd: Promise<void> | null,
  release: () => void,
): Response {
  if (callEnd !== null) {
    void waitThenRelease(callEnd, release);
  } else if (response.body === null) {
    release();

    return response;
  } else {
    request.signal.addEventListener('abort', release, { once: true });
  }

  if (response.body === null) {
    return response;
  }

  const held = tapStream(response.body, { onEnd: callEnd === null ? release : () => {} });

  return new Response(held, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function startPublicListener(deps: Readonly<PublicListenerDeps>): PublicListener {
  const handle = createPublicHandler(deps);

  const handleRequest = (request: Request, bunServer: Bun.Server<undefined>) =>
    handle(request, bunServer);

  const server = Bun.serve({
    port: deps.config.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: handleRequest,
    error: (error) => {
      getImpdLogger('public').warning('public mcp: {message}', { message: error.message });

      return new Response('internal error', { status: 500 });
    },
  });

  getImpdLogger('public').info('public mcp on :{port} for {origin}', {
    port: String(deps.config.port),
    origin: deps.config.origin,
  });

  return {
    port: server.port ?? deps.config.port,
    stop: async () => {
      await deps.mcp.close();
      await server.stop(true);
    },
  };
}

async function readControlRequest(request: Request): Promise<Request | null> {
  if (new URL(request.url).pathname !== MCP_PATH) {
    return null;
  }

  if (request.method === 'DELETE') {
    return request;
  }

  if (request.method !== 'POST') {
    return null;
  }

  const text = await readBodyText(request, MAX_CONTROL_BYTES);

  if (text === null || !isNotification(text)) {
    return null;
  }

  // Reading the body consumed it, so the transport gets a new request.
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: text,
    signal: request.signal,
  });
}

function isNotification(text: string): boolean {
  let message: unknown;

  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }

  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    !('id' in message) &&
    'method' in message &&
    typeof message.method === 'string'
  );
}

function buildTooMany(): Response {
  return new Response('too many requests', { status: 429, headers: { 'retry-after': '1' } });
}
