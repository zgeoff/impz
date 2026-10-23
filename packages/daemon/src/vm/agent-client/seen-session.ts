import type { SessionInfo } from '@impz/agent-protocol';

export type SeenSession = SessionInfo & { readonly observedUnixMs?: number };

export function toSeenSessions(list: readonly SessionInfo[], at: Date): SeenSession[] {
  return list.map((session) => ({ ...session, observedUnixMs: at.getTime() }));
}
