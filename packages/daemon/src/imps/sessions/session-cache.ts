import type { SessionInfo } from '@impz/agent-protocol';

export type SeenSession = SessionInfo & { readonly observedUnixMs?: number };

export interface SessionCache {
  readonly record: (impId: string, sessions: readonly SeenSession[]) => void;
  readonly read: (impId: string) => readonly SeenSession[] | undefined;
  readonly forget: (impId: string) => void;
}

export function createSessionCache(): SessionCache {
  const sessions = new Map<string, readonly SeenSession[]>();

  return {
    record: (impId, list) => {
      sessions.set(impId, list);
    },
    read: (impId) => sessions.get(impId),
    forget: (impId) => {
      sessions.delete(impId);
    },
  };
}

export function toSeenSessions(list: readonly SessionInfo[], at: Date): SeenSession[] {
  return list.map((session) => ({ ...session, observedUnixMs: at.getTime() }));
}
