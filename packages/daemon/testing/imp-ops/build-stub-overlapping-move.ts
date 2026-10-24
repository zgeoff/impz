import { MOVE_PATHS } from '../../src/imp-ops/moves/move-header';
import type { FetchHook } from './create-move-hosts';

export interface StubOverlappingMove {
  readonly hook: FetchHook;
  readonly arm: (runOther: () => Promise<unknown>) => void;
}

export function buildStubOverlappingMove(): StubOverlappingMove {
  const state: { runOther: (() => Promise<unknown>) | null } = { runOther: null };

  return {
    hook: async (request, forward) => {
      const runOther = state.runOther;

      if (!request.url.endsWith(MOVE_PATHS.receive) || runOther === null) {
        return forward();
      }

      state.runOther = null;

      await runOther();

      return forward();
    },
    arm: (runOther) => {
      state.runOther = runOther;
    },
  };
}
