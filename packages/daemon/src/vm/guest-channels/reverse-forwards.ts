import { createCountedLimit } from '../../platform/process/counted-limit';
import { MAX_RELAYS_PER_FORWARD } from './run-guest-listener';

export interface ReverseForwards {
  readonly register: (listener: string, impId: string, owner: string) => () => void;
  readonly tryAccept: (
    listener: string,
    impId: string,
    owner: string,
  ) => { readonly release: () => void } | { readonly refused: 'unknown' | 'full' };
  readonly isFull: (listener: string) => boolean;
}

interface ForwardEntry {
  readonly impId: string;
  readonly owner: string;
}

export function createReverseForwards(max = MAX_RELAYS_PER_FORWARD): ReverseForwards {
  const entries = new Map<string, ForwardEntry>();

  const relays = createCountedLimit(max);

  return {
    register: (listener, impId, owner) => {
      entries.set(listener, { impId, owner });

      return () => {
        entries.delete(listener);
      };
    },
    tryAccept: (listener, impId, owner) => {
      const entry = entries.get(listener);

      if (entry?.impId !== impId || entry.owner !== owner) {
        return { refused: 'unknown' };
      }

      const release = relays.tryClaim(listener);

      return release === null ? { refused: 'full' } : { release };
    },
    isFull: relays.isFull,
  };
}
