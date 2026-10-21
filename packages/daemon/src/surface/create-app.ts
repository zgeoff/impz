import {
  EXEC_CLOSE_RESTARTING,
  EXEC_PATH,
  EXEC_TICKET_PARAM,
  IMAGE_BUILD_PATH,
  MCP_PATH,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_PATH,
} from '@impz/api';
import type { ExecSocket } from '@impz/client';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { StrictGetMethodPlugin } from '@orpc/server/plugins';
import { Elysia } from 'elysia';
import { resolveCaller } from '../identity/auth/authenticate';
import type { CallerSources } from '../identity/auth/authenticate';
import { formatCaller, isCallerAllowed } from '../identity/auth/caller';
import type { Caller } from '../identity/auth/caller';
import { createLogouts } from '../identity/auth/logouts';
import type { Revocations } from '../identity/auth/revocations';
import { findBearer } from '../identity/auth/token-store';
import type { MoveService } from '../imp-ops/moves/move-service';
import { buildAuditedBackend } from '../imps/exec/audited-backend';
import { createExecSession } from '../imps/exec/exec-session';
import type { ExecSession } from '../imps/exec/exec-session';
import { createInProcessSocket } from '../imps/exec/in-process-socket';
import { createReverseForwards } from '../imps/reverse/reverse-forwards';
import { createTunnelLimits, createTunnelSession } from '../imps/tunnel/tunnel-session';
import type { TunnelSession } from '../imps/tunnel/tunnel-session';
import { redeemPeerAddress } from '../network/proxy/forwarded-peers';
import type { ForwardedPeers } from '../network/proxy/forwarded-peers';
import { withAuditedOpen } from '../platform/audit/api-audit';
import { isAllowedOrigin } from '../platform/http/is-allowed-origin';
import { getImpdLogger } from '../platform/process/get-impd-logger';
import type { ListenSpec } from '../vm/agent-client/listener-stream';
import { buildForbiddenError } from './api-errors';
import { createSessionHandler } from './auth/session-handler';
import { createDashboardRoutes } from './create-dashboard-routes';
import { createRouter } from './create-router';
import type { RouterDeps } from './create-router';
import { buildGrantedBackend } from './exec/exec-grant';
import type { ExecGrant } from './exec/exec-grant';
import { createExecTickets, isCallerLive } from './exec/exec-tickets';
import type { BuildContextRoute } from './images/build-context-route';
import { createMcpEndpoint } from './mcp/mcp-endpoint';
import { readBufferedAmount } from './read-buffered-amount';
import { toApiImage } from './to-api-image';
import { withRetryAfter } from './with-retry-after';

// Bun pings an idle exec socket and closes it when no answer comes, so a
// client that vanished without a close lets go of its session, and of the
// imp's idle timer, within a minute.
const EXEC_SOCKET_OPTIONS = { idleTimeout: 30, sendPings: true } as const;

// WebSocket's close code for a policy violation.
const CLOSE_REVOKED = 1008;
const EVENT_KEEPALIVE_MS = 5000;

export interface AppDeps extends Omit<RouterDeps, 'execTickets'> {
  readonly rootToken: string;
  readonly tailnet: CallerSources['tailnet'];
  readonly revocations: Revocations;
  readonly peers: ForwardedPeers;
  readonly isReady: () => boolean;
  readonly buildContexts: BuildContextRoute;
  readonly moves: MoveService;
  readonly logRpcFailure?: (failure: unknown) => void;
}

interface SocketEntry<Session> {
  readonly session: Session;
  readonly close: (code: number, reason: string) => void;
  readonly forget: () => void;
}

interface PeerServer {
  readonly requestIP: (request: Request) => { readonly address: string } | null;
  readonly timeout: (request: Request, seconds: number) => void;
}

export function createApp(deps: AppDeps) {
  const execTickets = createExecTickets({
    now: deps.now,
    isLive: (caller) => isCallerLive(deps.tokens, deps.revocations, caller),
  });

  const sources: CallerSources = {
    tokens: deps.tokens,
    rootToken: deps.rootToken,
    now: deps.now,
    tailnet: deps.tailnet,
  };

  const findCaller = (request: Request, server: PeerServer | null, cookie: boolean) => {
    const socket = server?.requestIP(request)?.address ?? null;
    const peer = redeemPeerAddress(request, socket, deps.peers);

    return resolveCaller(request, sources, { peer, cookie });
  };

  const logRpcFailure =
    deps.logRpcFailure ??
    ((failure: unknown) => {
      getImpdLogger('api').error('rpc failed: {failure}', { failure });
    });

  const handler = new RPCHandler(createRouter({ ...deps, execTickets }), {
    // A GET is what a link or an <img> on any page can make the browser send.
    plugins: [new StrictGetMethodPlugin()],

    // A silent event stream sends a comment this often, far inside the 360 s
    // that Bun's fetch waits for a byte.
    eventIteratorKeepAliveInterval: EVENT_KEEPALIVE_MS,
    interceptors: [
      onError((failure) => {
        if (!(failure instanceof ORPCError)) {
          logRpcFailure(failure);
        }
      }),
    ],
  });

  const sessions = new Map<string, SocketEntry<ExecSession>>();
  const tunnels = new Map<string, SocketEntry<TunnelSession>>();

  const tunnelLimits = createTunnelLimits();
  const reverseForwards = createReverseForwards();

  const grants = new WeakMap<Request, ExecGrant>();
  const tunnelCallers = new WeakMap<Request, Caller>();

  const logouts = createLogouts();

  const buildExecBackend = (grant: ExecGrant | undefined) => {
    const actor = grant?.caller ?? { kind: 'token', name: 'unknown' };

    return buildAuditedBackend(
      buildGrantedBackend(deps.imps, grant),
      deps.audit,
      actor,
      deps.imps.events,
      deps.now,
    );
  };

  const readRevoked = (caller: Readonly<Caller> | undefined): AbortSignal | null => {
    const signals = [
      deps.revocations.readSignal(caller?.tokenId ?? null),
      deps.revocations.readSignal(caller?.grantId ?? null),
    ].filter((signal) => signal !== null);

    return signals.length === 0 ? null : AbortSignal.any(signals);
  };

  const readEnds = (caller: Readonly<Caller>): AbortSignal | null => {
    const signals = [
      caller.kind === 'dashboard' ? logouts.readSignal() : null,
      readRevoked(caller),
    ].filter((signal) => signal !== null);

    return signals.length === 0 ? null : AbortSignal.any(signals);
  };

  const handleRevocation = (
    caller: Readonly<Caller> | undefined,
    close: () => void,
  ): (() => void) => {
    const signal = readRevoked(caller);

    if (signal?.aborted === true) {
      close();
    }

    signal?.addEventListener('abort', close);

    return () => signal?.removeEventListener('abort', close);
  };

  const handleRpc = async (request: Request, caller: Readonly<Caller>): Promise<Response> => {
    const handled = await handler.handle(request, {
      prefix: '/rpc',
      context: { caller, ends: readEnds(caller) },
    });

    if (!handled.matched) {
      return new Response('not found', { status: 404 });
    }

    return withRetryAfter(handled.response);
  };

  const openExecSocket = (url: string): ExecSocket => {
    const ticket = new URL(url).searchParams.get(EXEC_TICKET_PARAM);

    const holder = ticket === null ? null : execTickets.redeem(ticket);
    const id = `in-process-${crypto.randomUUID()}`;

    return createInProcessSocket((peer) => {
      if (holder === null) {
        return null;
      }

      const grant = { caller: holder.caller, name: holder.name };
      const session = createExecSession(peer, buildExecBackend(grant));

      const forget = handleRevocation(grant.caller, () => {
        peer.close(CLOSE_REVOKED, 'the token was removed');
      });

      sessions.set(id, { session, close: peer.close, forget });

      return {
        handleMessage: session.handleMessage,
        handleClose: () => {
          session.handleClose();

          forget();

          sessions.delete(id);
        },
      };
    });
  };

  const mcpServers = new WeakMap<Request, PeerServer | null>();

  const mcp = createMcpEndpoint({
    findCaller: (request) => findCaller(request, mcpServers.get(request) ?? null, false),
    handleRpc,
    connectExec: openExecSocket,
    readEnds,
  });

  const publicMcp = createMcpEndpoint({
    findCaller: (request) => {
      const bearer = findBearer(request.headers.get('authorization'));

      return bearer === null ? Promise.resolve(null) : deps.oauth.resolveAccess(bearer);
    },
    handleRpc,
    connectExec: openExecSocket,
    readEnds,
    isCrossOrigin: (request) =>
      !isAllowedOrigin(request, { kind: 'public-route', origin: deps.oauth.issuer }),
    challenge: `Bearer resource_metadata="${deps.oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="read"`,
  });

  const handleSession = createSessionHandler({
    tokens: deps.tokens,
    rootToken: deps.rootToken,
    now: deps.now,
    onLogout: logouts.logOut,
    logFailure: logRpcFailure,
  });

  const dashboardRoutes = createDashboardRoutes(deps.config.dashboardDir);

  const app = new Elysia({ websocket: EXEC_SOCKET_OPTIONS })
    .get('/health', () => ({
      status: 'ok',
      ready: deps.isReady(),
      warnings: buildHealthWarnings(deps.imps.readRebootReason(), deps.storage.readWarnings()),
    }))
    .use(dashboardRoutes)

    // parse: 'none' leaves the body unread for oRPC.
    .all(
      '/rpc*',
      async (context) => {
        const session = await handleSession(context.request);

        if (session !== null) {
          return session;
        }

        const caller = await findCaller(context.request, context.server, true);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        return handleRpc(context.request, caller);
      },
      { parse: 'none' },
    )

    // A tool call can run for minutes, so no idle timeout ends it.
    .all(
      MCP_PATH,
      (context) => {
        context.server?.timeout(context.request, 0);
        mcpServers.set(context.request, context.server);

        return mcp.respond(context.request);
      },
      { parse: 'none' },
    )

    .post(
      IMAGE_BUILD_PATH,
      async (context) => {
        const caller = await findCaller(context.request, context.server, true);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        context.server?.timeout(context.request, 0);

        return deps.buildContexts.respond(context.request, caller, toApiImage);
      },
      { parse: 'none' },
    )

    // The peer is the connected socket's address, never one a proxy
    // forwarded.
    .post(
      '/move/:step',
      (context) => {
        context.server?.timeout(context.request, 0);
        const peer = context.server?.requestIP(context.request)?.address ?? null;

        return deps.moves.respond(context.request, peer);
      },
      { parse: 'none' },
    )

    .ws(EXEC_PATH, {
      beforeHandle: async (context) => {
        const ticket = new URL(context.request.url).searchParams.get(EXEC_TICKET_PARAM);

        if (ticket !== null) {
          const holder = execTickets.redeem(ticket);

          if (holder === null) {
            return Response.json({ error: 'unauthorized' }, { status: 401 });
          }

          grants.set(context.request, { caller: holder.caller, name: holder.name });

          // Elysia ends the upgrade on any returned value, null included
          // oxlint-disable-next-line unicorn/no-useless-undefined
          return undefined;
        }

        const caller = await findCaller(context.request, context.server, false);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        grants.set(context.request, { caller, name: null });

        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      },
      open: (ws) => {
        const grant = grants.get(ws.data.request);

        const session = createExecSession(
          {
            sendText: (text) => {
              ws.raw.send(text);
            },

            // Bun answers 0 for a message it dropped.
            sendBinary: (data) => ws.raw.send(data) !== 0,
            close: (code, reason) => {
              ws.raw.close(code, reason);
            },
            readBufferedAmount: () => readBufferedAmount(ws.raw),
          },
          buildExecBackend(grant),
        );

        const forget = handleRevocation(grant?.caller, () => {
          ws.raw.close(CLOSE_REVOKED, 'the token was removed');
        });

        sessions.set(ws.id, {
          session,
          close: (code, reason) => {
            ws.raw.close(code, reason);
          },
          forget,
        });
      },
      message: (ws, message) => {
        sessions.get(ws.id)?.session.handleMessage(message);
      },
      drain: (ws) => {
        sessions.get(ws.id)?.session.handleDrain();
      },
      close: (ws) => {
        const entry = sessions.get(ws.id);

        entry?.session.handleClose();
        entry?.forget();
        sessions.delete(ws.id);
      },
    })

    .ws(TUNNEL_PATH, {
      beforeHandle: async (context) => {
        const caller = await findCaller(context.request, context.server, false);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        tunnelCallers.set(context.request, caller);

        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      },
      open: (ws) => {
        const caller = tunnelCallers.get(ws.data.request);

        const peer = {
          close: (code: number, reason: string): void => {
            ws.raw.close(code, reason);
          },
        };

        const session = createTunnelSession(
          {
            sendText: (text) => {
              ws.raw.send(text);
            },
            sendBinary: (data) => {
              ws.raw.send(data);
            },
            close: peer.close,
          },
          {
            readImpId: async (name) => {
              if (caller === undefined || !isCallerAllowed(caller, 'exec', name)) {
                const who = caller === undefined ? 'nobody' : formatCaller(caller);

                throw buildForbiddenError(`${who} may not open a tunnel into imp ${name}`);
              }

              const imp = await deps.imps.readImp(name);

              return imp.id;
            },
            openDial: (name, target) => {
              const port = target.address.split(':').at(-1) ?? '';

              return withAuditedOpen(
                deps.audit,
                {
                  procedure: `tunnel:${port}`,
                  actor: caller ?? { kind: 'token', name: 'unknown' },
                  impName: name,
                  startedAt: deps.now(),
                },
                () => deps.imps.openDial(name, target, 'tunnel'),
              );
            },
            openListener: (name, spec) => {
              const where = 'port' in spec ? String(spec.port) : readListenPath(spec);

              return withAuditedOpen(
                deps.audit,
                {
                  procedure: `reverse:${where}`,
                  actor: caller ?? { kind: 'token', name: 'unknown' },
                  impName: name,
                  startedAt: deps.now(),
                },
                () => deps.imps.openListener(name, spec, null),
              );
            },
            openAccept: (name, listener, connection) =>
              deps.imps.openAccept(name, listener, connection, 'tunnel'),
            owner:
              caller === undefined ? '' : `${caller.kind}:${caller.name}:${caller.tokenId ?? ''}`,
          },
          tunnelLimits,
          reverseForwards,
        );

        const forget = handleRevocation(caller, () => {
          peer.close(CLOSE_REVOKED, 'the token was removed');
        });

        tunnels.set(ws.id, { session, close: peer.close, forget });
      },
      message: (ws, message) => {
        tunnels.get(ws.id)?.session.handleMessage(message);
      },
      close: (ws) => {
        const entry = tunnels.get(ws.id);

        entry?.session.handleClose();
        entry?.forget();
        tunnels.delete(ws.id);
      },
    });

  return {
    app,
    publicMcp,

    closeExecSessions: () => {
      deps.imps.endLogFollows();

      for (const entry of sessions.values()) {
        entry.close(EXEC_CLOSE_RESTARTING, 'impd is restarting');
      }

      for (const entry of tunnels.values()) {
        entry.close(TUNNEL_CLOSE_RESTARTING, 'impd is restarting');
      }
    },
  };
}

function buildHealthWarnings(
  rebootReason: string | null,
  storageWarnings: readonly string[],
): string[] {
  const reboot = rebootReason === null ? [] : [`host needs a reboot: ${rebootReason}`];

  return [...reboot, ...storageWarnings];
}

function readListenPath(spec: ListenSpec): string {
  return spec.network === 'unix' ? (spec.path ?? 'auto') : spec.network;
}
