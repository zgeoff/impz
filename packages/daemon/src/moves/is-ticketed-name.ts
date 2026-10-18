// whether a stream's header names the imp its ticket is for: the exact
// name, with no case folding, trimming or normalizing
export function isTicketedName(ticketName: string, headerName: string): boolean {
  return headerName === ticketName;
}
