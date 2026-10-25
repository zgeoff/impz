import { MoveCommitReplySchema, movePeerContract } from '@impz/api';
import {
  ORPCError,
  createORPCClient,
  createORPCErrorFromJson,
  isORPCErrorJson,
} from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import * as z from 'zod';
import type { ConnectMovePeer } from '../../imp-ops/moves/move-peer';
import { sendToPeer } from '../../imp-ops/moves/send-to-peer';
import type { PeerDeps } from '../../imp-ops/moves/send-to-peer';
import { getErrorMessage } from '../../platform/process/get-error-message';

type MovePeerClient = ContractRouterClient<typeof movePeerContract>;

export function makeConnectMovePeer(deps: PeerDeps): ConnectMovePeer {
  return (target) => {
    const sendLinkRequest = async (request: Request): Promise<Response> => {
      const body = await request.text();

      const type = request.headers.get('content-type');

      return sendToPeer(deps, {
        peer: target.peer,
        path: new URL(request.url).pathname,
        ticket: target.ticket,
        init: {
          ...(body !== '' && { body }),
          signal: request.signal,
          extraHeaders: type === null ? {} : { 'content-type': type },
        },
      });
    };

    const link = new OpenAPILink(movePeerContract, {
      url: target.peer,
      fetch: sendLinkRequest,
      customErrorResponseBodyDecoder: decodePeerError,

      // The output schemas default each field an older target leaves out.
      plugins: [new ResponseValidationPlugin(movePeerContract)],
    });

    const client: MovePeerClient = createORPCClient(link);

    return {
      offer: (offer, signal) => withPeerError('offer', () => client.offer(offer, { signal })),
      commit: () => withPeerError('commit', () => client.commit()),
      abort: async () => {
        try {
          const reply = await client.abort();

          return reply.isCommitted ? 'committed' : 'aborted';
        } catch (error) {
          if (error instanceof ORPCError && error.status === 401) {
            return 'unknown-ticket';
          }

          // An older target answers the abort of a committed move with a 409 that holds the reply.
          const answered: unknown = error instanceof ORPCError ? error.data : null;
          const committed = MoveCommitReplySchema.safeParse(answered);

          if (committed.success && committed.data.isCommitted) {
            return 'committed';
          }

          throw toPeerError('abort', error);
        }
      },
    };
  };
}

const PeerErrorBodySchema = z.looseObject({ error: z.string().optional() });

// An older impd's error body holds only its text, under `error`.
function decodePeerError(
  body: unknown,
  response: Readonly<{ status: number }>,
): ORPCError<string, unknown> | null {
  const parsed = PeerErrorBodySchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  const { error: text, ...rest } = parsed.data;

  if (isORPCErrorJson(rest)) {
    return createORPCErrorFromJson(rest);
  }

  return new ORPCError('MOVE_PEER_ERROR', {
    status: response.status,
    message: text ?? 'with no error text',
    data: rest,
  });
}

async function withPeerError<T>(procedure: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toPeerError(procedure, error);
  }
}

function toPeerError(procedure: string, error: unknown): Error {
  if (!(error instanceof ORPCError)) {
    return error instanceof Error ? error : new Error(getErrorMessage(error));
  }

  return new Error(`${procedure}: the target answered ${String(error.status)} ${error.message}`, {
    cause: error,
  });
}
