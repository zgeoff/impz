import { EXEC_CLOSE_RESTARTING, EXEC_PATH, EXEC_TICKET_PARAM } from '@impz/api';
import type { ExecSocket } from '@impz/client';
import { Elysia } from 'elysia';
import { buildAuditedBackend } from '../imps/exec/audited-backend';
import { createExecSession } from '../imps/exec/exec-session';
import type { ExecSession } from '../imps/exec/exec-session';
import { createInProcessSocket } from '../imps/exec/in-process-socket';
import type { ImpService } from '../imps/imps/imp-service';
import type { ApiAudit } from '../platform/audit/api-audit';
import type { Caller } from '../platform/principal/caller';
import { createSocketRegistry } from './create-socket-registry';
import { buildGrantedBackend } from './exec/exec-grant';
import type { ExecGrant } from './exec/exec-grant';
import type { ExecTickets } from './exec/exec-tickets';
import { readBufferedAmount } from './read-buffered-amount';

// WebSocket's close code for a policy violation.
const CLOSE_REVOKED = 1008;

interface PeerServer {
  readonly requestIP: (request: Request) => { readonly address: string } | null;
}

export interface ExecSocketDeps {
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

  const grants = new WeakMap<Request, ExecGrant>();

  const buildExecBackend = (grant: ExecGrant | undefined) => {
    const actor = grant?.caller ?? { kind: 'token', name: 'unknown' };

    return buildAuditedBackend({
      backend: buildGrantedBackend(deps.imps, grant),
      audit: deps.audit,
      actor,
      events: deps.imps.events,
      now: deps.now,
    });
  };

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

  const route = new Elysia().ws(EXEC_PATH, {
    beforeHandle: async (context) => {
      const ticket = new URL(context.request.url).searchParams.get(EXEC_TICKET_PARAM);

      if (ticket !== null) {
        const holder = deps.execTickets.redeem(ticket);

        if (holder === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        grants.set(context.request, { caller: holder.caller, name: holder.name });

        // Elysia ends the upgrade on any returned value, null included
        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      }

      const caller = await deps.findCaller(context.request, context.server);

      if (caller === null) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      grants.set(context.request, { caller, name: null });

      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    },
    open: (ws) => {
      const grant = grants.get(ws.data.request);

      const close = (code?: number, reason?: string): void => {
        ws.raw.close(code, reason);
      };

      const session = createExecSession(
        {
          sendText: (text) => {
            ws.raw.send(text);
          },

          // Bun answers 0 for a message it dropped.
          sendBinary: (data) => ws.raw.send(data) !== 0,
          close,
          readBufferedAmount: () => readBufferedAmount(ws.raw),
        },
        buildExecBackend(grant),
      );

      const forget = deps.closeOnRevocation(grant?.caller, () => {
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
