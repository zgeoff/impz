import { readMoveTicket } from '../../platform/db/move-tickets';
import type { MoveTicketRow } from '../../platform/db/move-tickets';
import type { ImpQueries } from '../../platform/db/open-database';
import { hashSecret } from '../../platform/secrets/hash-secret';
import type { OpaqueToken } from '../../platform/secrets/parse-opaque-token';
import { MoveRequestError } from './move-request-error';
import { isSameHash, readTicketHeader } from './move-tickets';

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
