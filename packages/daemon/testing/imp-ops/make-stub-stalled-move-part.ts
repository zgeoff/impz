import { MOVE_PART_HEADER } from '../../src/imp-ops/moves/move-header';
import type { FetchHook } from './create-move-hosts';

export function makeStubStalledMovePart(onStalled: () => void): FetchHook {
  return (request, forward) => {
    if (request.headers.get(MOVE_PART_HEADER) !== '0') {
      return forward();
    }

    const stalled = Promise.withResolvers<Response>();

    request.signal.addEventListener('abort', () => {
      stalled.reject(request.signal.reason);
    });

    onStalled();

    return stalled.promise;
  };
}
