import type { ImpQueries } from '../../platform/db/open-database';
import { readMoveTicket } from '../../platform/db/read-move-ticket';
import type { MoveTicketRow } from '../../platform/db/read-move-ticket';
import { hashSecret } from '../../platform/secrets/hash-secret';
import type { OpaqueToken } from '../../platform/secrets/parse-opaque-token';
import { isSameHash, readTicketHeader } from './build-ticket-header';
import { MoveRequestError } from './move-request-error';

export interface CheckedTicket {
  readonly row: MoveTicketRow;
  readonly ticket: OpaqueToken;
}

export async function requireMoveTicket(db: ImpQueries, request: Request): Promise<CheckedTicket> {
  const ticket = readTicketHeader(request);

  if (ticket === null) {
    throw new MoveRequestError('UNAUTHORIZED', 'no move ticket in the Authorization header');
  }

  const row = await readMoveTicket(db, ticket.id);

  if (
    row === undefined ||
    !isSameHash(row.secret_sha256, hashSecret(ticket.secret).toString('hex'))
  ) {
    throw new MoveRequestError('UNAUTHORIZED', 'unknown move ticket');
  }

  return { row, ticket };
}
