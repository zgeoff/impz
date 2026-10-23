import { MCP_PATH } from '@impz/api';
import type { HttpTransport } from '@impz/mcp';
import type { McpAuth } from '../../identity/oauth/create-mcp-auth';
import type { PublicMcpConfig } from '../../identity/oauth/public-mcp-config';
import { readBodyText } from '../../identity/oauth/read-body-text';
import { tapStream } from '../../platform/process/tap-stream';
import { createPublicApp } from './create-public-app';

const MAX_OPEN = 64;
const MAX_CONTROL = 16;
const MAX_CONTROL_BYTES = 16 * 1024;

// A JSON-RPC message carries a file write's content, 4 MiB as text.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDLE_TIMEOUT_S = 30;

export interface PublicListenerDeps {
  readonly config: PublicMcpConfig;
  readonly oauth: Pick<McpAuth, 'handlers'>;
  readonly mcp: HttpTransport;
}

type TimeoutServer = Pick<Bun.Server<undefined>, 'timeout'>;

export interface PublicListener {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/* @internal */
export function createPublicHandler(
  deps: Readonly<PublicListenerDeps>,
  log: (message: string) => void,
): (request: Request, server: TimeoutServer | null) => Promise<Response> {
  const state = { open: 0, control: 0 };

  const servers = new WeakMap<Request, TimeoutServer>();

  const host = deps.config.host.toLowerCase();

  const app = createPublicApp({
    oauth: deps.oauth.handlers,
    mcp: deps.mcp,
    holdOpen: (request) => {
      servers.get(request)?.timeout(request, 0);
    },
    log,
  });

  const handleRequest = (request: Request, server: TimeoutServer | null): Promise<Response> => {
    // A name the front did not route here, or a page that rebinds DNS.
    if ((request.headers.get('host') ?? '').toLowerCase() !== host) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }

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

      return holdUntilDone(request, response, deps.mcp.readCallEnd(response), release);
    } catch (error) {
      release();
      throw error;
    }
  };
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

export function startPublicListener(
  deps: Readonly<PublicListenerDeps>,
  log: (message: string) => void,
): PublicListener {
  const handle = createPublicHandler(deps, log);

  const handleRequest = (request: Request, bunServer: Bun.Server<undefined>) =>
    handle(request, bunServer);

  const server = Bun.serve({
    port: deps.config.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: handleRequest,
    error: (error) => {
      log(`impd: public mcp: ${error.message}`);

      return new Response('internal error', { status: 500 });
    },
  });

  log(`impd: public mcp on :${String(deps.config.port)} for ${deps.config.origin}`);

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
