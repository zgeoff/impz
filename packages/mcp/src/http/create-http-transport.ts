import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  createMcpHandler,
  isInitializeRequest,
  isJSONRPCRequest,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import type { AuthInfo, RequestId } from '@modelcontextprotocol/server';
import { createCallRegistry } from '../create-call-registry';
import { createCallerAuth, findCallerAuth } from '../create-caller-auth';
import { createImpServer } from '../create-imp-server';
import type { ImpServerOptions } from '../create-imp-server';
import { createLegacySessions } from './create-legacy-sessions';
import type { LegacySession, SessionOwner } from './create-legacy-sessions';

export type McpPrincipal = SessionOwner;

export interface HttpTransportOptions extends ImpServerOptions {
  readonly authenticate: (request: Request) => Promise<McpPrincipal | null>;
  readonly isCrossOrigin: (request: Request) => boolean;
  readonly challenge?: string;

  // An SSE comment at this interval keeps an idle timeout from ending a long
  // call's stream.
  readonly keepaliveMs?: number;
  readonly limits?: { readonly perCaller: number; readonly total: number; readonly idleMs: number };
  readonly now?: () => number;
}

export interface HttpTransport {
  readonly respond: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;

  // Settles when the tool call ends, which neither a dropped stream nor an
  // aborted request hastens.
  readonly readCallEnd: (response: Response) => Promise<void> | null;
}

interface Exchange {
  readonly authInfo: AuthInfo;
  readonly ended: Readonly<PromiseWithResolvers<void>> | null;
  started: boolean;
}

const SESSION_HEADER = 'mcp-session-id';
const KEEPALIVE_MS = 5000;
const DEFAULT_LIMITS = { perCaller: 16, total: 256, idleMs: 3_600_000 };

export function createHttpTransport(options: Readonly<HttpTransportOptions>): HttpTransport {
  const now = options.now ?? Date.now;
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const challenge = options.challenge ?? 'Bearer';

  const callEnds = new WeakMap<Response, Promise<void>>();
  const running = new Set<Promise<void>>();

  // The SDK keeps one stream and one abort per request id, which a second call
  // with the same id would replace.
  const sessionCallIDs = new WeakMap<LegacySession, Set<RequestId>>();

  const sessions = createLegacySessions({
    limits: options.limits ?? DEFAULT_LIMITS,
    now,
    keepaliveMs,
    createServer: (owner, calls) => createImpServer(options, owner, calls),
  });

  const modern = createMcpHandler(
    (context) => {
      const auth = findCallerAuth(context.authInfo);

      if (auth === null) {
        throw new Error('an MCP request reached the server without its caller');
      }

      return createImpServer(options, auth.caller, createCallRegistry());
    },
    { legacy: 'reject', keepAliveMs: keepaliveMs },
  );

  const startExchange = (message: unknown, principal: Readonly<McpPrincipal>): Exchange => {
    if (!isJSONRPCRequest(message) || message.method !== 'tools/call') {
      return { authInfo: createCallerAuth(principal), ended: null, started: false };
    }

    const ended = Promise.withResolvers<void>();

    running.add(ended.promise);

    void (async () => {
      await ended.promise;

      running.delete(ended.promise);
    })();

    const exchange: Exchange = {
      authInfo: createCallerAuth(principal, {
        onCallStart: () => {
          exchange.started = true;
        },
        onCallEnd: ended.resolve,
      }),
      ended,
      started: false,
    };

    return exchange;
  };

  // A call the SDK has not started once its microtasks have run, such as one
  // its schema refuses, never runs.
  const waitForExchangeStart = async (
    exchange: Readonly<Exchange>,
    response: Response,
  ): Promise<Response> => {
    if (exchange.ended === null) {
      return response;
    }

    await waitForMicrotasks();

    if (!exchange.started) {
      exchange.ended.resolve();
    }

    callEnds.set(response, exchange.ended.promise);

    return response;
  };

  const handleModern = async (
    request: Request,
    body: string,
    message: unknown,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    const exchange = startExchange(message, principal);
    const signals = principal.ends === null ? [request.signal] : [request.signal, principal.ends];

    const response = await modern.fetch(
      new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body,
        signal: AbortSignal.any(signals),
      }),
      { authInfo: exchange.authInfo, parsedBody: message },
    );

    return waitForExchangeStart(exchange, response);
  };

  const runInSession = async (
    session: Readonly<LegacySession>,
    request: Request,
    message: unknown,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    const ids = sessionCallIDs.get(session) ?? new Set<RequestId>();

    sessionCallIDs.set(session, ids);

    if (isJSONRPCRequest(message) && message.method === 'tools/call' && ids.has(message.id)) {
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: INVALID_PARAMS,
          message: `request ${String(message.id)} is already running`,
        },
      });
    }

    const exchange = startExchange(message, principal);

    if (exchange.ended !== null && isJSONRPCRequest(message)) {
      const id = message.id;

      ids.add(id);
      sessions.track(session, exchange.ended.promise);

      // The SDK sends a cancelled call no answer, which would leave its stream
      // open until the session ends.
      const ended = exchange.ended.promise;

      void (async () => {
        await ended;
        await waitForMicrotasks();

        ids.delete(id);
        session.transport.closeSSEStream(id);
      })();
    }

    const response = await session.transport.handleRequest(request, {
      authInfo: exchange.authInfo,
      parsedBody: message,
    });

    return waitForExchangeStart(exchange, response);
  };

  const handleLegacy = async (
    request: Request,
    message: unknown,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    if (isInitializeRequest(message)) {
      const opened = await sessions.open(principal);

      if (opened === null) {
        return buildText(429, 'too many MCP sessions: end one with a DELETE first');
      }

      return runInSession(opened, request, message, principal);
    }

    const found = findSession(request, principal);

    return found instanceof Response ? found : runInSession(found, request, message, principal);
  };

  const handlePost = async (
    request: Request,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return buildText(415, 'a POST carries one JSON-RPC message as application/json');
    }

    const body = await request.text();

    let message: unknown;

    try {
      message = JSON.parse(body);
    } catch {
      return buildRpcError(400, PARSE_ERROR, 'parse error: not JSON');
    }

    // MCP has no JSON-RPC batches from protocol version 2025-06-18 on.
    if (Array.isArray(message)) {
      return buildRpcError(400, INVALID_REQUEST, 'invalid request: send one message per POST');
    }

    const isLegacy = await isLegacyRequest(request, message);

    return isLegacy
      ? handleLegacy(request, message, principal)
      : handleModern(request, body, message, principal);
  };

  const findSession = (
    request: Request,
    principal: Readonly<McpPrincipal>,
  ): LegacySession | Response => {
    const id = request.headers.get(SESSION_HEADER);

    if (id === null) {
      return buildRpcError(400, -32_000, `no ${SESSION_HEADER}: initialize first`);
    }

    return sessions.findOwned(id, principal.key) ?? buildText(404, 'no such MCP session');
  };

  const handleDelete = async (
    request: Request,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    const found = findSession(request, principal);

    if (found instanceof Response) {
      return found;
    }

    await sessions.end(found);

    return new Response(null, { status: 204 });
  };

  return {
    respond: async (request) => {
      if (options.isCrossOrigin(request)) {
        return buildText(403, 'a page on another origin may not call MCP');
      }

      if (request.method !== 'POST' && request.method !== 'DELETE') {
        return buildText(405, 'POST a message, or DELETE a session', { allow: 'POST, DELETE' });
      }

      sessions.sweep();

      const principal = await options.authenticate(request);

      if (principal === null) {
        return buildText(401, 'unauthorized', { 'www-authenticate': challenge });
      }

      return request.method === 'POST'
        ? handlePost(request, principal)
        : handleDelete(request, principal);
    },
    close: async () => {
      await modern.close();
      await sessions.endAll();
      await Promise.all(running);
    },
    readCallEnd: (response) => callEnds.get(response) ?? null,
  };
}

// setImmediate fires once every queued microtask, and each one it queues, has
// run.
function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function buildText(
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  });
}

function buildRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code, message } },
    { status, headers: { 'content-type': 'application/json' } },
  );
}
