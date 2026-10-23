export interface SocketEntry<Session> {
  readonly session: Session;
  readonly close: (code: number, reason: string) => void;
  readonly forget: () => void;
}

export interface SocketRegistry<Session> {
  readonly add: (id: string, entry: SocketEntry<Session>) => void;
  readonly findSession: (id: string) => Session | undefined;
  readonly remove: (id: string) => SocketEntry<Session> | undefined;
  readonly closeAll: (code: number, reason: string) => void;
}

export function createSocketRegistry<Session>(): SocketRegistry<Session> {
  const entries = new Map<string, SocketEntry<Session>>();

  return {
    add: (id, entry) => {
      entries.set(id, entry);
    },
    findSession: (id) => entries.get(id)?.session,
    remove: (id) => {
      const entry = entries.get(id);

      entries.delete(id);
      entry?.forget();

      return entry;
    },
    closeAll: (code, reason) => {
      for (const entry of entries.values()) {
        entry.close(code, reason);
      }
    },
  };
}
