import { MoveRequestError } from './move-request-error';

export function requireTicketedName(ticketName: string, headerName: string): void {
  if (headerName !== ticketName) {
    throw new MoveRequestError('FORBIDDEN', `the ticket is for ${ticketName}, not ${headerName}`);
  }
}
