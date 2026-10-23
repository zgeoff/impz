import type { SeenSession } from '../../vm/agent-client/seen-session';

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
