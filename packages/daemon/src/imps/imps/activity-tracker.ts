const CONNECTION_KINDS = ['exec', 'proxy', 'ssh', 'tunnel'] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export interface ActivityTracker {
  readonly open: (impId: string, kind: ConnectionKind) => () => void;
  readonly count: (impId: string, kind?: ConnectionKind) => number;
}

export function buildActivityTracker(): ActivityTracker {
  const counts = new Map<string, number>();

  const readCount = (impId: string, kind: ConnectionKind): number =>
    counts.get(buildKey(impId, kind)) ?? 0;

  return {
    open: (impId, kind) => {
      const key = buildKey(impId, kind);
      let open = true;

      counts.set(key, (counts.get(key) ?? 0) + 1);

      return () => {
        if (!open) {
          return;
        }

        open = false;

        const left = (counts.get(key) ?? 1) - 1;

        if (left === 0) {
          counts.delete(key);
        } else {
          counts.set(key, left);
        }
      };
    },
    count: (impId, kind) =>
      kind === undefined
        ? CONNECTION_KINDS.reduce((sum, each) => sum + readCount(impId, each), 0)
        : readCount(impId, kind),
  };
}

function buildKey(impId: string, kind: ConnectionKind): string {
  return `${impId}:${kind}`;
}
