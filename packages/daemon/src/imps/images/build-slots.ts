// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';

const MAX_BUILDS = 4;

export interface BuildSlots {
  readonly claim: () => () => void;
}

export function createBuildSlots(max = MAX_BUILDS): BuildSlots {
  const running = { count: 0 };

  return {
    claim: () => {
      if (running.count >= max) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: `${String(max)} image builds are already uploading or running; try again`,
        });
      }

      running.count += 1;

      return () => {
        running.count -= 1;
      };
    },
  };
}
