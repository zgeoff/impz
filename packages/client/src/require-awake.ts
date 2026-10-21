import type { Imp, ImpContract } from '@impz/api';
import { ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import pRetry from 'p-retry';

export interface RequireAwakeOptions {
  readonly restartError?: boolean;
  readonly retryUnavailable?: { readonly attempts: number; readonly delayMs: number };
  readonly signal?: Readonly<AbortSignal>;
}

export async function requireAwake(
  rpc: Readonly<ContractRouterClient<ImpContract>>,
  name: string,
  options: Readonly<RequireAwakeOptions> = {},
): Promise<Imp> {
  const signal = options.signal;
  const callOptions = signal === undefined ? {} : { signal };
  const retry = options.retryUnavailable ?? { attempts: 0, delayMs: 0 };
  const input = { name, restartError: options.restartError === true };

  // p-retry gives up on a TypeError it does not know as a network failure,
  // and Bun's is one of those, so each failure travels wrapped.
  const wake = async (): Promise<Imp> => {
    try {
      return await rpc.imps.wake(input, callOptions);
    } catch (error) {
      throw new WakeFailureError(error);
    }
  };

  try {
    return await pRetry(wake, {
      retries: retry.attempts,
      minTimeout: retry.delayMs,
      factor: 1,
      ...(signal !== undefined && { signal }),

      // impd refuses a wake over the RAM budget again on a retry.
      shouldRetry: (context) =>
        context.error instanceof WakeFailureError && isUnavailable(context.error.failure),
    });
  } catch (error) {
    throw error instanceof WakeFailureError ? error.failure : error;
  }
}

class WakeFailureError extends Error {
  override name = 'WakeFailureError';

  readonly failure: unknown;

  constructor(failure: unknown) {
    const message = failure instanceof Error ? failure.message : String(failure);

    super(message);

    this.failure = failure;
  }
}

// fetch rejects with a TypeError when it cannot connect, in browsers, Bun and
// Node alike.
function isUnavailable(error: unknown): boolean {
  if (error instanceof ORPCError) {
    return error.code === 'SERVICE_UNAVAILABLE';
  }

  return error instanceof TypeError;
}
