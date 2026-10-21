import type { ImpEvent } from '@impz/api';
import { ORPCError } from '@orpc/client';
import pRetry, { AbortError } from 'p-retry';
import type { RetryContext } from 'p-retry';
import { P, match } from 'ts-pattern';
import type { CallOptions } from '../types';
import { UnknownProcedureError } from '../unknown-procedure-error';

export interface EventSource {
  readonly events: {
    readonly stream: (input?: undefined, options?: CallOptions) => Promise<AsyncIterable<ImpEvent>>;
  };
}

export interface WatchReconnect {
  readonly delayMs: number;
  readonly shouldRetry?: (error: unknown) => boolean;
}

export interface WatchEventsOptions {
  readonly onEvent: (event: ImpEvent) => Promise<void> | void;
  readonly name?: string;
  readonly signal?: AbortSignal;
  readonly onOpen?: (attempt: number) => Promise<void> | void;
  readonly reconnect?: WatchReconnect;
}

export async function watchEvents(
  client: EventSource,
  options: Readonly<WatchEventsOptions>,
): Promise<void> {
  const signal = options.signal;
  const reconnect = options.reconnect;
  const callOptions: CallOptions = signal === undefined ? {} : { signal };

  const readStream = async (attempt: number): Promise<void> => {
    const stream = await client.events.stream(undefined, callOptions).catch((error: unknown) => {
      throw new StreamEndError(error);
    });

    const events = stream[Symbol.asyncIterator]();
    const reading = { done: false };

    try {
      await runCallback(() => options.onOpen?.(attempt));

      for (;;) {
        const next = await events.next().catch((error: unknown) => {
          throw new StreamEndError(error);
        });

        if (next.done === true) {
          reading.done = true;
          throw new StreamEndError(null);
        }

        if (options.name === undefined || readEventImpName(next.value) === options.name) {
          await runCallback(() => options.onEvent(next.value));
        }
      }
    } finally {
      if (!reading.done) {
        await disposeEvents(events);
      }
    }
  };

  const shouldReconnect = (context: RetryContext): boolean => {
    const error = context.error;
    const shouldRetry = reconnect?.shouldRetry ?? isNotRefused;

    return error instanceof StreamEndError && (error.reason === null || shouldRetry(error.reason));
  };

  try {
    await (reconnect === undefined
      ? readStream(1)
      : pRetry(readStream, {
          retries: Number.POSITIVE_INFINITY,
          minTimeout: reconnect.delayMs,
          factor: 1,
          ...(signal !== undefined && { signal }),
          shouldRetry: shouldReconnect,
        }));
  } catch (error) {
    requireCleanEnd(error, signal);
  }
}

class StreamEndError extends Error {
  override name = 'StreamEndError';

  readonly reason: unknown;

  constructor(reason: unknown) {
    const message = reason instanceof Error ? reason.message : 'the event stream ended';

    super(message);

    this.reason = reason;
  }
}

// p-retry's AbortError ends the retries at once.
async function runCallback(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));

    throw new AbortError(failure);
  }
}

function readEventImpName(event: Readonly<ImpEvent>): string {
  return match(event)
    .with({ ev: P.union('ImpAdded', 'ImpChanged', 'ImpRemoved') }, (changed) => changed.imp.name)
    .with(
      { ev: P.union('CheckpointAdded', 'CheckpointRemoved', 'GovernorDecision', 'AgentExec') },
      (named) => named.name,
    )
    .exhaustive();
}

async function disposeEvents(events: AsyncIterator<ImpEvent>): Promise<void> {
  try {
    await events.return?.();
  } catch {
    // the stream ended either way
  }
}

function isNotRefused(error: unknown): boolean {
  if (error instanceof UnknownProcedureError) {
    return false;
  }

  return !(error instanceof ORPCError && error.status >= 400 && error.status < 500);
}

function requireCleanEnd(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    return;
  }

  // p-retry unwraps a callback's throw, but without a reconnect no p-retry
  // runs.
  if (error instanceof AbortError) {
    throw error.originalError;
  }

  if (!(error instanceof StreamEndError)) {
    throw error;
  }

  if (error.reason instanceof Error) {
    throw error.reason;
  }

  if (error.reason !== null) {
    throw new Error('the event stream failed', { cause: error.reason });
  }
}
