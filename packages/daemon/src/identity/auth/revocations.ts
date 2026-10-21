export interface Revocations {
  readonly readSignal: (id: string | null) => AbortSignal | null;
  readonly revoke: (id: string) => void;

  readonly isRevoked: (id: string) => boolean;
}

export function createRevocations(): Revocations {
  const controllers = new Map<string, AbortController>();
  const revoked = new Set<string>();

  return {
    readSignal: (id) => {
      if (id === null) {
        return null;
      }

      if (revoked.has(id)) {
        return AbortSignal.abort();
      }

      const existing = controllers.get(id);

      if (existing !== undefined) {
        return existing.signal;
      }

      const controller = new AbortController();

      controllers.set(id, controller);

      return controller.signal;
    },
    revoke: (id) => {
      revoked.add(id);
      controllers.get(id)?.abort();
      controllers.delete(id);
    },
    isRevoked: (id) => revoked.has(id),
  };
}
