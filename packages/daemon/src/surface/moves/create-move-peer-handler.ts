import { MOVE_RECEIVE_PATH, movePeerContract } from '@impz/api';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ORPCError, implement, onError } from '@orpc/server';
import { match } from 'ts-pattern';
import type { MovePeerCalls } from '../../imp-ops/moves/move-receiver';
import { MoveRequestError } from '../../imp-ops/moves/move-request-error';
import type { CheckedTicket } from '../../imp-ops/moves/require-move-ticket';
import type { ApiAudit } from '../../platform/audit/api-audit';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { toORPCError } from '../to-orpc-error';

export interface MovePeerHandler {
  readonly respond: (request: Request, peer: string | null) => Promise<Response>;
}

interface MovePeerHandlerDeps {
  readonly calls: MovePeerCalls;
  readonly audit: Pick<ApiAudit, 'record'>;
  readonly now: () => number;
}

interface MovePeerContext {
  readonly request: Request;
  readonly peer: string | null;
}

export function createMovePeerHandler(deps: MovePeerHandlerDeps): MovePeerHandler {
  const withTicket = async <T>(
    step: string,
    context: MovePeerContext,
    call: (checked: CheckedTicket) => T | PromiseLike<T>,
  ): Promise<T> => {
    const startedAt = deps.now();
    const found: { checked: CheckedTicket | null } = { checked: null };

    const record = (failure: unknown) => {
      deps.audit.record(
        {
          procedure: `move.${step}`,
          actor: { kind: 'tailnet', name: `move from ${context.peer ?? 'unknown'}` },
          impName: found.checked?.row.name ?? null,
          startedAt,
        },
        failure,
      );
    };

    try {
      if (!deps.calls.isAllowedPeer(context.peer)) {
        throw new MoveRequestError('FORBIDDEN', 'moves come only over the tailnet');
      }

      found.checked = await deps.calls.requireTicket(context.request);

      const result = await call(found.checked);

      record(null);

      return result;
    } catch (error) {
      record(error);
      throw error;
    }
  };

  const peer = implement(movePeerContract)
    .$context<MovePeerContext>()
    .use(async (options) => {
      try {
        return await withTicket(options.path.join('.'), options.context, (checked) =>
          options.next({ context: { checked } }),
        );
      } catch (error) {
        throw toORPCError(error);
      }
    });

  const router = peer.router({
    offer: peer.offer.handler((options) => deps.calls.offer(options.input)),
    commit: peer.commit.handler((options) => deps.calls.commit(options.context.checked)),
    abort: peer.abort.handler((options) => deps.calls.abort(options.context.checked)),
  });

  const handler = new OpenAPIHandler(router, {
    customErrorResponseBodyEncoder: encodePeerError,
    interceptors: [
      onError((failure) => {
        if (!(failure instanceof ORPCError)) {
          getImpdLogger('move').error('{error}', { error: getErrorMessage(failure) });
        }
      }),
    ],
  });

  const respondReceive = async (context: MovePeerContext): Promise<Response> => {
    try {
      const received = await withTicket('receive', context, (checked) =>
        deps.calls.receive(checked, context.request),
      );

      return match(received)
        .with({ kind: 'part' }, (sent) => Response.json({ part: sent.part }, { status: 202 }))
        .with({ kind: 'receipt' }, (sent) => Response.json(sent.receipt))
        .exhaustive();
    } catch (error) {
      const failure = toPeerError(error);

      return Response.json(encodePeerError(failure), { status: failure.status });
    }
  };

  return {
    respond: async (request, peerAddress) => {
      const context = { request, peer: peerAddress };

      if (request.method === 'POST' && new URL(request.url).pathname === MOVE_RECEIVE_PATH) {
        return respondReceive(context);
      }

      const handled = await handler.handle(request, { context });

      return handled.matched
        ? handled.response
        : Response.json({ error: 'not found' }, { status: 404 });
    },
  };
}

// An older source reads only the text under `error`.
function encodePeerError(error: ORPCError<string, unknown>): unknown {
  return { ...error.toJSON(), error: error.message };
}

function toPeerError(error: unknown): ORPCError<string, unknown> {
  const converted = toORPCError(error);

  if (converted instanceof ORPCError) {
    const data: unknown = converted.data;

    return new ORPCError(String(converted.code), {
      status: converted.status,
      message: converted.message,
      data,
      cause: converted.cause,
    });
  }

  getImpdLogger('move').error('{error}', { error: getErrorMessage(error) });

  return new ORPCError('INTERNAL_SERVER_ERROR', { message: getErrorMessage(error) });
}
