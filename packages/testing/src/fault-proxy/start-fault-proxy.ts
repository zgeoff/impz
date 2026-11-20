import { EXEC_PATH, TUNNEL_PATH } from '@impz/api';
import type { ServerWebSocket } from 'bun';
import type {
  DefinedFault,
  ExecRefusal,
  FailOptions,
  FaultHandle,
  RawFault,
  RecordedCall,
} from '../types';
import { buildFaultResponse } from './build-fault-response';
import { buildSystemAnswer } from './build-system-answer';
import { createFaultRules } from './fault-rules';
import { findProcedure } from './find-procedure';
import { createOpenGate } from './open-gate';
import { parseRpcInput } from './parse-rpc-input';

export interface FaultProxyOptions {
  readonly impdUrl: string;
  readonly version?: string;
  readonly features?: Readonly<Record<string, boolean>>;
}

export interface FaultProxy {
  readonly url: string;
  readonly calls: RecordedCall[];
  readonly fail: (
    procedure: string,
    answer: DefinedFault | RawFault,
    options?: FailOptions,
  ) => FaultHandle;
  readonly stall: (procedure: string) => FaultHandle;
  readonly clearFaults: () => void;
  readonly dropConnections: () => void;
  readonly freeze: () => void;
  readonly thaw: () => void;
  readonly refuseExec: (error: ExecRefusal) => void;
  readonly closeTunnels: (code: number, reason: string) => void;
}

type UpstreamEvent =
  | { readonly kind: 'message'; readonly data: string | ArrayBuffer }
  | { readonly kind: 'close'; readonly code: number; readonly reason: string };

interface SocketData {
  readonly pathname: string;
  readonly refusal: ExecRefusal | null;
  upstream: WebSocket | null;

  // what impd sent after it accepted the socket and before the client's socket was open
  readonly early: UpstreamEvent[];
  relay: ((event: UpstreamEvent) => void) | null;
}

// a request the proxy has taken and not yet finished answering
interface Flight {
  readonly upstream: AbortController;
  readonly drop: PromiseWithResolvers<Response>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
}

const SYSTEM_PROCEDURES = new Set(['system/info', 'system/features']);

// headers that belong to one hop or to the WebSocket handshake, which each side makes for itself
const HANDSHAKE_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

const NORMAL_CLOSE = 1000;

export function startFaultProxy(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<FaultProxyOptions>,
): FaultProxy {
  const rules = createFaultRules();
  const gate = createOpenGate();
  const calls: RecordedCall[] = [];

  const flights = new Set<Flight>();
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const execRefusals: ExecRefusal[] = [];

  const relayRequest = async (request: Request, flight: Flight): Promise<Response> => {
    const url = new URL(request.url);

    const procedure = findProcedure(url.pathname);

    // an oRPC call's body is read whole, so the proxy can decode its input; any other body streams
    const bytes = procedure === null ? null : await request.arrayBuffer();
    const buffered = bytes === null ? null : new Uint8Array(bytes);

    if (procedure !== null && buffered !== null) {
      const input = parseRpcInput(request.headers.get('content-type'), buffered);

      calls.push({ procedure, input, authorization: request.headers.get('authorization') });

      const action = rules.take(procedure, input);

      if (action?.kind === 'stall') {
        return await new Promise<Response>(() => {});
      }

      if (action?.kind === 'answer') {
        await gate.wait();

        return buildFaultResponse(action.answer);
      }
    }

    await gate.wait();

    const headers = new Headers(request.headers);

    headers.delete('host');

    const body = buffered ?? request.body;
    const hasBody = body !== null && (!(body instanceof Uint8Array) || body.byteLength > 0);

    const target = new URL(`${url.pathname}${url.search}`, options.impdUrl);

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: flight.upstream.signal,
      ...(hasBody && { body }),
    });

    const answerHeaders = new Headers(upstream.headers);

    // the fetch has decoded the body, so its length and encoding no longer describe it
    answerHeaders.delete('content-encoding');
    answerHeaders.delete('content-length');

    const isSystemAnswer =
      procedure !== null &&
      SYSTEM_PROCEDURES.has(procedure) &&
      upstream.ok &&
      (options.version !== undefined || options.features !== undefined);

    if (isSystemAnswer) {
      const answer = await upstream.text();

      return new Response(buildSystemAnswer(answer, options), {
        status: upstream.status,
        headers: answerHeaders,
      });
    }

    const source = upstream.body?.getReader();

    if (source === undefined) {
      return new Response(null, { status: upstream.status, headers: answerHeaders });
    }

    const relayed = new ReadableStream<Uint8Array>({
      start: (controller) => {
        flight.controller = controller;
      },
      pull: async (controller) => {
        const chunk = await source.read();

        await gate.wait();

        if (chunk.done) {
          flights.delete(flight);
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel: async (reason) => {
        flights.delete(flight);
        flight.upstream.abort();

        await source.cancel(reason);
      },
    });

    return new Response(relayed, { status: upstream.status, headers: answerHeaders });
  };

  const answerRequest = async (request: Request, flight: Flight): Promise<Response> => {
    try {
      const response = await relayRequest(request, flight);

      // no connection outlives its answer, so dropConnections reaches every open socket
      response.headers.set('connection', 'close');

      return response;
    } catch (error) {
      return new Response(`the fault proxy failed to reach impd: ${String(error)}`, {
        status: 502,
        headers: { connection: 'close' },
      });
    }
  };

  const takeRequest = (request: Request): Promise<Response> => {
    const flight: Flight = {
      upstream: new AbortController(),
      drop: Promise.withResolvers<Response>(),
      controller: null,
    };

    flights.add(flight);

    request.signal.addEventListener('abort', () => {
      flights.delete(flight);
      flight.upstream.abort();
    });

    return Promise.race([answerRequest(request, flight), flight.drop.promise]);
  };

  const handleRequest = async (
    request: Request,
    server: Bun.Server<SocketData>,
  ): Promise<Response | undefined> => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return await takeRequest(request);
    }

    const url = new URL(request.url);

    const headers: Record<string, string> = {};

    for (const [name, value] of request.headers) {
      if (!HANDSHAKE_HEADERS.has(name)) {
        headers[name] = value;
      }
    }

    await gate.wait();

    const refusal = url.pathname === EXEC_PATH ? (execRefusals.shift() ?? null) : null;

    const data: SocketData = {
      pathname: url.pathname,
      refusal,
      upstream: null,
      early: [],
      relay: null,
    };

    // impd decides whether the socket opens, so a refused handshake never opens it for the client
    if (refusal === null && !(await connectUpstream(data, url, headers))) {
      return new Response('impd refused the socket', {
        status: 502,
        headers: { connection: 'close' },
      });
    }

    return server.upgrade(request, { data })
      ? undefined
      : new Response('upgrade failed', { status: 400 });
  };

  const connectUpstream = (
    data: SocketData,
    url: URL,
    headers: Readonly<Record<string, string>>,
  ): Promise<boolean> => {
    const target = new URL(`${url.pathname}${url.search}`, options.impdUrl);

    target.protocol = 'ws:';

    const upstream = new WebSocket(target.href, { headers });

    upstream.binaryType = 'arraybuffer';

    const opened = Promise.withResolvers<boolean>();

    const emit = (event: UpstreamEvent): void => {
      if (data.relay === null) {
        data.early.push(event);
      } else {
        data.relay(event);
      }
    };

    upstream.addEventListener('open', () => {
      data.upstream = upstream;

      opened.resolve(true);
    });

    upstream.addEventListener('error', () => {
      opened.resolve(false);
    });

    upstream.addEventListener('message', (event) => {
      const received: unknown = event.data;

      if (typeof received === 'string' || received instanceof ArrayBuffer) {
        emit({ kind: 'message', data: received });
      }
    });

    upstream.addEventListener('close', (event) => {
      opened.resolve(false);

      emit({ kind: 'close', code: event.code, reason: event.reason });
    });

    return opened.promise;
  };

  const relayUpstream = (ws: ServerWebSocket<SocketData>, event: UpstreamEvent): void => {
    gate.pass(() => {
      if (!sockets.has(ws)) {
        return;
      }

      if (event.kind === 'message') {
        ws.send(event.data);
      } else {
        ws.close(pickCloseCode(event.code), event.reason);
      }
    });
  };

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handleRequest,
    websocket: {
      open: (ws) => {
        sockets.add(ws);

        const refusal = ws.data.refusal;

        if (refusal === null) {
          ws.data.relay = (event) => {
            relayUpstream(ws, event);
          };

          for (const event of ws.data.early.splice(0)) {
            relayUpstream(ws, event);
          }

          return;
        }

        gate.pass(() => {
          ws.send(JSON.stringify({ type: 'error', ...refusal }));
          ws.close(NORMAL_CLOSE);
        });
      },
      message: (ws, message) => {
        gate.pass(() => {
          const upstream = ws.data.upstream;

          if (upstream?.readyState === WebSocket.OPEN) {
            upstream.send(message);
          }
        });
      },
      close: (ws, code, reason) => {
        sockets.delete(ws);

        gate.pass(() => {
          ws.data.upstream?.close(pickCloseCode(code), reason);
        });
      },
    },
    error: (error) => new Response(String(error), { status: 500 }),
  });

  stack.defer(async () => {
    for (const ws of sockets) {
      ws.data.upstream?.close();
    }

    await server.stop(true);
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    calls,
    fail: (procedure, answer, failOptions) =>
      rules.add(procedure, { kind: 'answer', answer }, failOptions),
    stall: (procedure) => rules.add(procedure, { kind: 'stall' }),
    clearFaults: () => {
      rules.clear();
    },
    dropConnections: () => {
      for (const ws of sockets) {
        ws.data.upstream?.close();
        ws.terminate();
      }

      for (const flight of flights) {
        flight.upstream.abort();

        // a response that Bun cannot send ends the socket with no answer
        flight.drop.resolve(Response.error());
        flight.controller?.error('the fault proxy dropped the connection');
      }

      flights.clear();
    },
    freeze: () => {
      gate.close();
    },
    thaw: () => {
      gate.open();
    },
    refuseExec: (error) => {
      execRefusals.push(error);
    },
    closeTunnels: (code, reason) => {
      for (const ws of sockets) {
        if (ws.data.pathname === TUNNEL_PATH) {
          ws.data.upstream?.close();
          ws.close(code, reason);
        }
      }
    },
  };
}

const UPSTREAM_FAILED_CLOSE = 1011;

// 1005, 1006 and 1015 mark a missing or failed close and never go on the wire
function pickCloseCode(code: number): number {
  return code === 1005 || code === 1006 || code === 1015 ? UPSTREAM_FAILED_CLOSE : code;
}
