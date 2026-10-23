import { TUNNEL_CLOSE_RESTARTING, TUNNEL_PATH } from '@impz/api';
import { Elysia } from 'elysia';
import type { ImpService } from '../imps/imps/imp-service';
import { createReverseForwards } from '../imps/reverse/reverse-forwards';
import { createTunnelLimits, createTunnelSession } from '../imps/tunnel/tunnel-session';
import type { TunnelSession } from '../imps/tunnel/tunnel-session';
import { withAuditedOpen } from '../platform/audit/api-audit';
import type { ApiAudit } from '../platform/audit/api-audit';
import { buildForbiddenError } from '../platform/errors/impd-errors';
import { formatCaller, isCallerAllowed } from '../platform/principal/caller';
import type { Caller } from '../platform/principal/caller';
import type { ListenSpec } from '../vm/agent-client/listener-stream';
import { createSocketRegistry } from './create-socket-registry';

// WebSocket's close code for a policy violation.
const CLOSE_REVOKED = 1008;

interface PeerServer {
  readonly requestIP: (request: Request) => { readonly address: string } | null;
}

interface TunnelSocketDeps {
  readonly imps: Pick<ImpService, 'readImp' | 'openDial' | 'openListener' | 'openAccept'>;
  readonly audit: Pick<ApiAudit, 'record'>;
  readonly now: () => number;
  readonly findCaller: (request: Request, server: PeerServer | null) => Promise<Caller | null>;
  readonly closeOnRevocation: (
    caller: Readonly<Caller> | undefined,
    close: () => void,
  ) => () => void;
}

export function createTunnelSocketRoute(deps: TunnelSocketDeps) {
  const tunnels = createSocketRegistry<TunnelSession>();
  const tunnelLimits = createTunnelLimits();
  const reverseForwards = createReverseForwards();

  const callers = new WeakMap<Request, Caller>();

  const route = new Elysia().ws(TUNNEL_PATH, {
    beforeHandle: async (context) => {
      const caller = await deps.findCaller(context.request, context.server);

      if (caller === null) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      callers.set(context.request, caller);

      // Elysia ends the upgrade on any returned value, null included
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    },
    open: (ws) => {
      const caller = callers.get(ws.data.request);

      const close = (code: number, reason: string): void => {
        ws.raw.close(code, reason);
      };

      const session = createTunnelSession(
        {
          sendText: (text) => {
            ws.raw.send(text);
          },
          sendBinary: (data) => {
            ws.raw.send(data);
          },
          close,
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

      const forget = deps.closeOnRevocation(caller, () => {
        close(CLOSE_REVOKED, 'the token was removed');
      });

      tunnels.add(ws.id, { session, close, forget });
    },
    message: (ws, message) => {
      tunnels.findSession(ws.id)?.handleMessage(message);
    },
    close: (ws) => {
      tunnels.remove(ws.id)?.session.handleClose();
    },
  });

  return {
    route,
    closeTunnels: () => {
      tunnels.closeAll(TUNNEL_CLOSE_RESTARTING, 'impd is restarting');
    },
  };
}

function readListenPath(spec: ListenSpec): string {
  return spec.network === 'unix' ? (spec.path ?? 'auto') : spec.network;
}
