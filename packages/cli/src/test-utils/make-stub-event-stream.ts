import type { watchEvents } from '@impz/client';

// Opens once and sends no event, then ends: with the failure when one is
// given, as a dropped stream does, or cleanly, as impd ending it does.
export function makeStubEventStream(failure: Error | null): typeof watchEvents {
  return async (_client, options) => {
    await options.onOpen?.(1);

    if (failure !== null) {
      throw failure;
    }
  };
}
