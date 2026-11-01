import { ORPCError, UnknownProcedureError, watchEvents } from '@impz/client';
import type { EventSource as ClientEventSource, ServerCheck } from '@impz/client';
import pRetry, { AbortError } from 'p-retry';
import { defineCommand } from '../cli/define-command';
import { runAction } from '../cli/run-action';

const MAX_FAILURES = 5;
const HEALTHY_MS = 10_000;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15_000;

interface EventSource extends ClientEventSource {
  readonly checkServer: () => Promise<Pick<ServerCheck, 'clientVersion' | 'serverVersion'>>;
  readonly now: () => number;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly warn: (line: string) => void;
}

/* @internal */
export async function printEvents(
  source: EventSource,
  name: string | null,
  print: (line: string) => void,
): Promise<void> {
  const streak = { failures: 0 };

  const readUntilEnd = async (): Promise<void> => {
    const startedAt = source.now();

    const ended = await readStream(source, name, print);

    if (source.now() - startedAt >= HEALTHY_MS) {
      streak.failures = 0;
    }

    streak.failures += 1;

    if (streak.failures >= MAX_FAILURES) {
      throw new AbortError(
        `the event stream ended ${String(streak.failures)} times in a row: ${ended}`,
      );
    }

    throw new StreamEndedError(ended);
  };

  await pRetry(readUntilEnd, {
    retries: Number.POSITIVE_INFINITY,
    minTimeout: 0,
    // oxlint-disable-next-line zgeoff/verb-contract -- p-retry's option name
    shouldRetry: async (context) => {
      if (!(context.error instanceof StreamEndedError)) {
        return false;
      }

      const backoffMs = Math.min(FIRST_BACKOFF_MS * 2 ** (streak.failures - 1), MAX_BACKOFF_MS);

      source.warn(
        `impz: the event stream ended (${context.error.message}); reconnecting in ${String(backoffMs)}ms`,
      );

      await source.wait(backoffMs);

      return true;
    },
  });
}

class StreamEndedError extends Error {
  override name = 'StreamEndedError';
}

export const eventsCommand = defineCommand({
  name: 'events',
  description: 'Follow impd: every imp, then each change, as one JSON object a line',
  args: {
    name: { type: 'positional', description: 'imp name (default: every imp)', required: false },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, (client) =>
      printEvents(
        {
          events: client.events,
          checkServer: () => client.checkServer(),
          now: Date.now,
          wait: (durationMs) => Bun.sleep(durationMs),
          warn: (line) => {
            ctx.extensions.impz.io.printError(line);
          },
        },
        ctx.values.name ?? null,
        (line) => {
          ctx.extensions.impz.io.print(line);
        },
      ),
    ),
});

async function readStream(
  source: EventSource,
  name: string | null,
  print: (line: string) => void,
): Promise<string> {
  try {
    await watchEvents(source, {
      ...(name !== null && { name }),
      onEvent: (event) => {
        print(JSON.stringify(event));
      },
    });

    return 'impd closed it';
  } catch (error) {
    // an impd from before the stream has no such procedure
    if (isMissingStream(error)) {
      const check = await source.checkServer();

      throw new Error(
        `impd ${check.serverVersion} has no event stream; upgrade it to ${check.clientVersion}`,
        { cause: error },
      );
    }

    if (!(error instanceof ORPCError) || error.status < 400 || error.status >= 500) {
      return error instanceof Error ? error.message : String(error);
    }

    throw error;
  }
}

// impd answers a path no procedure matches with a plain-text 404, and an
// oRPC router answers it with NOT_FOUND
function isMissingStream(error: unknown): boolean {
  return (
    error instanceof UnknownProcedureError || (error instanceof ORPCError && error.status === 404)
  );
}
