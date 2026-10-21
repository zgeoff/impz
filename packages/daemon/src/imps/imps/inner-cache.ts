import type { InnerStatus } from '../../vm/agent-client/agent-protocol';

export interface InnerCache {
  readonly record: (impId: string, inner: InnerStatus) => void;

  readonly read: (impId: string) => InnerStatus | undefined;

  readonly forget: (impId: string) => void;
}

export function createInnerCache(): InnerCache {
  const inners = new Map<string, InnerStatus>();

  return {
    record: (impId, inner) => {
      inners.set(impId, inner);
    },
    read: (impId) => inners.get(impId),
    forget: (impId) => {
      inners.delete(impId);
    },
  };
}
