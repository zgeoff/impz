import { MoveRequestError } from './move-request-error';

export function requireTicketedName(ticketName: string, headerName: string): void {
  if (headerName !== ticketName) {
    throw new MoveRequestError(403, `the ticket is for ${ticketName}, not ${headerName}`);
  }
}
