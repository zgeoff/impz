import type { ChangeSignal } from '@impz/durable';
import type { LoggedImpEvent } from './imp-log-entry';
import type { ImpEventsAfter } from './read-imp-events-after';

export type ImpEventsReset = Extract<ImpEventsAfter, { kind: 'reset' }>;

interface TailImpEventsOptions {
  readonly changes: ChangeSignal;
  readonly readAfter: (after: number) => Promise<ImpEventsAfter>;
  readonly after: number;
  readonly signal: AbortSignal;

  // when given, a failed read calls it and the tail reads again after the next commit; without
  // it, the failure ends the tail
  readonly onReadError?: (error: unknown) => void;
}

export async function* tailImpEvents(
  options: TailImpEventsOptions,
): AsyncGenerator<readonly LoggedImpEvent[], ImpEventsReset | null> {
  // a tail of its own, so the wait it leaves behind on a return or a throw ends with it
  const stop = new AbortController();

  const stopTail = (): void => {
    stop.abort();
  };

  options.signal.addEventListener('abort', stopTail);

  try {
    let cursor = options.after;
    let changed: Promise<void> | null = null;

    while (!options.signal.aborted) {
      // taken before the read, so a commit during the read still wakes the wait; kept across
      // the reads of a backlog, so each pass adds no abort listener to the signal
      changed ??= options.changes.next(stop.signal);

      const read = await readOrReport(options, cursor);

      if (read === null) {
        await changed;

        changed = null;
        continue;
      }

      if (read.kind === 'reset') {
        return read;
      }

      if (read.events.length > 0) {
        yield read.events;
      }

      cursor = read.throughSeq;

      if (!read.hasMore) {
        await changed;

        changed = null;
      }
    }

    return null;
  } finally {
    options.signal.removeEventListener('abort', stopTail);
    stop.abort();
  }
}

async function readOrReport(
  options: TailImpEventsOptions,
  cursor: number,
): Promise<ImpEventsAfter | null> {
  if (options.onReadError === undefined) {
    return options.readAfter(cursor);
  }

  try {
    return await options.readAfter(cursor);
  } catch (error) {
    options.onReadError(error);

    return null;
  }
}
