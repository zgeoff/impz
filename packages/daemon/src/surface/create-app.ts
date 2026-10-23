import { BUILD_CONTEXT_PATH, MCP_PATH } from '@impz/api';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { StrictGetMethodPlugin } from '@orpc/server/plugins';
import { Elysia } from 'elysia';
import { resolveCaller } from '../identity/auth/authenticate';
import type { CallerSources } from '../identity/auth/authenticate';
import { createLogouts } from '../identity/auth/logouts';
import type { Revocations } from '../identity/auth/revocations';
import { findBearer } from '../identity/auth/token-store';
import type { MoveService } from '../imp-ops/moves/move-service';
import { redeemPeerAddress } from '../network/proxy/forwarded-peers';
import type { ForwardedPeers } from '../network/proxy/forwarded-peers';
import { isAllowedOrigin } from '../platform/http/is-allowed-origin';
import type { Caller } from '../platform/principal/caller';
import { getImpdLogger } from '../platform/process/get-impd-logger';
import { createSessionHandler } from './auth/session-handler';
import { createDashboardRoutes } from './create-dashboard-routes';
import { createExecSockets } from './create-exec-sockets';
import { createRouter } from './create-router';
import type { RouterDeps } from './create-router';
import { createTunnelSocketRoute } from './create-tunnel-socket-route';
import { createExecTickets, isCallerLive } from './exec/exec-tickets';
import type { BuildContextRoute } from './images/build-context-route';
import { createMcpEndpoint } from './mcp/mcp-endpoint';
import { withRetryAfter } from './with-retry-after';

// Bun pings an idle exec socket and closes it when no answer comes, so a
// client that vanished without a close lets go of its session, and of the
// imp's idle timer, within a minute.
const EXEC_SOCKET_OPTIONS = { idleTimeout: 30, sendPings: true } as const;
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

  const findCaller = (
    request: Request,
    server: Pick<PeerServer, 'requestIP'> | null,
    cookie: boolean,
  ) => {
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

  const logouts = createLogouts();

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

  const socketDeps = {
    imps: deps.imps,
    audit: deps.audit,
    now: deps.now,
    findCaller: (request: Request, server: Pick<PeerServer, 'requestIP'> | null) =>
      findCaller(request, server, false),
    closeOnRevocation: handleRevocation,
  };

  const execSockets = createExecSockets({ ...socketDeps, execTickets });
  const tunnelSockets = createTunnelSocketRoute(socketDeps);

  const mcpServers = new WeakMap<Request, PeerServer | null>();

  const mcp = createMcpEndpoint({
    findCaller: (request) => findCaller(request, mcpServers.get(request) ?? null, false),
    handleRpc,
    connectExec: execSockets.openExecSocket,
    readEnds,
  });

  const publicMcp = createMcpEndpoint({
    findCaller: (request) => {
      const bearer = findBearer(request.headers.get('authorization'));

      return bearer === null ? Promise.resolve(null) : deps.oauth.resolveAccess(bearer);
    },
    handleRpc,
    connectExec: execSockets.openExecSocket,
    readEnds,
    isCrossOrigin: (request) =>
      !isAllowedOrigin(request, { kind: 'public-route', origin: deps.oauth.issuer }),
    challenge: `Bearer resource_metadata="${deps.oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="read"`,
  });

  const sessionCalls = createSessionHandler({
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
        const answered = await sessionCalls.respond(context.request);

        if (answered !== null) {
          return answered;
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
      BUILD_CONTEXT_PATH,
      async (context) => {
        const caller = await findCaller(context.request, context.server, true);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        context.server?.timeout(context.request, 0);

        return deps.buildContexts.respond(context.request, caller);
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

    .use(execSockets.route)
    .use(tunnelSockets.route);

  return {
    app,
    publicMcp,

    closeExecSessions: () => {
      deps.imps.endLogFollows();
      execSockets.closeSessions();
      tunnelSockets.closeTunnels();
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
