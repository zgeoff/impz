import { MoveRequestError } from './move-request-error';

// A 403 unless a stream's header names the imp its ticket is for: the exact
// name, with no case folding, trimming or normalizing
export function requireTicketedName(ticketName: string, headerName: string): void {
  if (headerName !== ticketName) {
    throw new MoveRequestError(403, `the ticket is for ${ticketName}, not ${headerName}`);
  }
}
