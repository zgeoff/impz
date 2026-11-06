import type { FetchHook } from './create-move-hosts';

interface DroppedCommitOptions {
  readonly count?: number;
  readonly drops?: 'request' | 'answer';
}

export function makeStubDroppedCommit(options: Readonly<DroppedCommitOptions> = {}): FetchHook {
  const left = { count: options.count ?? 1 };
  const drops = options.drops ?? 'request';

  return async (request, forward) => {
    if (!request.url.endsWith('/move/commit') || left.count === 0) {
      return forward();
    }

    left.count -= 1;

    if (drops === 'request') {
      throw new Error('the network dropped the commit');
    }

    await forward();

    throw new Error('the network dropped the answer');
  };
}
