import type { RunOwner } from './read-run-owner';

export function formatRunPrefix(owner: RunOwner): string {
  return `pid${String(owner.pid)}-ns${owner.namespace}-`;
}
