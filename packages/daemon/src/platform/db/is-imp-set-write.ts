import type { ImpWrite } from './imp-write-feed';

// Ports and grants follow the raw write, never its event, so a failure to
// build an event cannot leave a port open or closed.
export function isImpSetWrite(write: Readonly<ImpWrite>): boolean {
  if (write.kind === 'changed') {
    return write.reason === 'stopped';
  }

  return write.kind === 'added' || write.kind === 'removed';
}
