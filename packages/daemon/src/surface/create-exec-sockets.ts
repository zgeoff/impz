import { EXEC_CLOSE_RESTARTING, EXEC_PATH, EXEC_TICKET_PARAM } from '@impz/api';
import type { ExecSocket } from '@impz/client';
import { Elysia, status } from 'elysia';
import { websocket } from 'elysia/websocket';
import { createExecSession } from '../imps/exec/exec-session';
import type { ExecSession } from '../imps/exec/exec-session';
import { createInProcessSocket } from '../imps/exec/in-process-socket';
import type { ImpService } from '../imps/imps/imp-service';
import type { ApiAudit } from '../platform/audit/api-audit';
import type { Caller } from '../platform/principal/caller';
import { createSocketRegistry } from './create-socket-registry';
import { buildAuditedBackend } from './exec/audited-backend';
import { buildGrantedBackend } from './exec/exec-grant';
import type { ExecGrant } from './exec/exec-grant';
import type { ExecTickets } from './exec/exec-tickets';
import { getRawSocket } from './get-raw-socket';
import { readBufferedAmount } from './read-buffered-amount';

// WebSocket's close code for a policy violation.
const CLOSE_REVOKED = 1008;

interface PeerServer {
  readonly requestIP: (request: Request) => { readonly address: string } | null;
}

interface ExecSocketDeps {
  readonly imps: ImpService;
  readonly audit: Pick<ApiAudit, 'record'>;
  readonly now: () => number;
  readonly execTickets: ExecTickets;
  readonly findCaller: (request: Request, server: PeerServer | null) => Promise<Caller | null>;
  readonly closeOnRevocation: (
    caller: Readonly<Caller> | undefined,
    close: () => void,
  ) => () => void;
}

export function createExecSockets(deps: ExecSocketDeps) {
  const sessions = createSocketRegistry<ExecSession>();

  const buildExecBackend = (grant: ExecGrant) =>
    buildAuditedBackend({
      backend: buildGrantedBackend(deps.imps, grant),
      audit: deps.audit,
      actor: grant.caller,
      events: deps.imps.events,
      now: deps.now,
    });

  const openExecSocket = (url: string): ExecSocket => {
    const ticket = new URL(url).searchParams.get(EXEC_TICKET_PARAM);

    const holder = ticket === null ? null : deps.execTickets.redeem(ticket);
    const id = `in-process-${crypto.randomUUID()}`;

    return createInProcessSocket((peer) => {
      if (holder === null) {
        return null;
      }

      const grant = { caller: holder.caller, name: holder.name };
      const session = createExecSession(peer, buildExecBackend(grant));

      const forget = deps.closeOnRevocation(grant.caller, () => {
        peer.close(CLOSE_REVOKED, 'the token was removed');
      });

      sessions.add(id, { session, close: peer.close, forget });

      return {
        handleMessage: session.handleMessage,
        handleClose: () => {
          sessions.remove(id)?.session.handleClose();
        },
      };
    });
  };

  // Elysia runs a WebSocket route's beforeHandle again on each message, and a
  // derive only at the upgrade, so a ticket is redeemed once.
  const authorized = new Elysia().use(websocket()).derive(async (context) => {
    const ticket = new URL(context.request.url).searchParams.get(EXEC_TICKET_PARAM);

    if (ticket !== null) {
      const holder = deps.execTickets.redeem(ticket);

      if (holder === null) {
        return status(401, { error: 'unauthorized' });
      }

      return { grant: { caller: holder.caller, name: holder.name } };
    }

    const caller = await deps.findCaller(context.request, context.server);

    if (caller === null) {
      return status(401, { error: 'unauthorized' });
    }

    return { grant: { caller, name: null } };
  });

  const route = authorized.ws(EXEC_PATH, {
    open: (ws) => {
      const grant = ws.grant;
      const raw = getRawSocket(ws);

      const close = (code?: number, reason?: string): void => {
        raw.close(code, reason);
      };

      const session = createExecSession(
        {
          sendText: (text) => {
            raw.send(text);
          },

          // Bun answers 0 for a message it dropped.
          sendBinary: (data) => raw.send(data) !== 0,
          close,
          readBufferedAmount: () => readBufferedAmount(raw),
        },
        buildExecBackend(grant),
      );

      const forget = deps.closeOnRevocation(grant.caller, () => {
        close(CLOSE_REVOKED, 'the token was removed');
      });

      sessions.add(ws.id, { session, close, forget });
    },
    message: (ws, message) => {
      sessions.findSession(ws.id)?.handleMessage(message);
    },
    drain: (ws) => {
      sessions.findSession(ws.id)?.handleDrain();
    },
    close: (ws) => {
      sessions.remove(ws.id)?.session.handleClose();
    },
  });

  return {
    route,
    openExecSocket,
    closeSessions: () => {
      sessions.closeAll(EXEC_CLOSE_RESTARTING, 'impd is restarting');
    },
  };
}
