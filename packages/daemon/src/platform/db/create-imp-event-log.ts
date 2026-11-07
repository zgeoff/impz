import { createChangeSignal, readEventHead } from '@impz/durable';
import type { ChangeSignal } from '@impz/durable';
import { getErrorMessage } from '@impz/shared';
import { createEventBus } from '../events/event-bus';
import type { EventBus } from '../events/event-bus';
import { getImpdLogger } from '../process/get-impd-logger';
import { appendImpEvent } from './append-imp-event';
import type { ImpLogEntry, LoggedImpEvent } from './imp-log-entry';
import type { ImpQueries } from './open-database';
import { readImpEventsAfter } from './read-imp-events-after';
import type { ImpEventsAfter } from './read-imp-events-after';

export interface ImpEventLog {
  // a writer notifies after each commit; a reader of the table waits on it, and reads again
  readonly changes: ChangeSignal;

  // impd's own followers share one cursor, taken at start, so a new follower may get events
  // committed before it subscribed
  readonly subscribe: EventBus<LoggedImpEvent>['subscribe'];

  // impd's clock, which stamps each event a transaction appends
  readonly now: () => number;

  // for an event no row of impd's describes, such as a decision of the RAM governor; it logs a
  // failure and never rejects
  readonly write: (entry: Readonly<ImpLogEntry>, at: number) => Promise<void>;

  readonly readHead: () => Promise<number>;
  readonly readAfter: (after: number, limit: number) => Promise<ImpEventsAfter>;

  // resolves once the follower holds its cursor, so it misses no write that comes after
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function createImpEventLog(db: ImpQueries, now: () => number): ImpEventLog {
  const changes = createChangeSignal();
  const followers = createEventBus<LoggedImpEvent>();

  const controller = new AbortController();

  const state: { following: Promise<void> | null } = { following: null };

  return {
    changes,
    subscribe: followers.subscribe,
    now,
    write: async (entry, at) => {
      try {
        await appendImpEvent(db, entry, at);

        changes.notify();
      } catch (error) {
        getImpdLogger('events').warning('failed to write a {ev} event: {error}', {
          ev: entry.ev,
          error: getErrorMessage(error),
        });
      }
    },
    readHead: () => readEventHead(db),
    readAfter: (after, limit) => readImpEventsAfter(db, { after, limit }),
    start: async () => {
      const head = await readEventHead(db);

      state.following = runFollower(db, { changes, followers, signal: controller.signal }, head);
    },
    stop: async () => {
      controller.abort();

      await state.following;
    },
  };
}

interface FollowerParts {
  readonly changes: ChangeSignal;
  readonly followers: EventBus<LoggedImpEvent>;
  readonly signal: AbortSignal;
}

const READ_LIMIT = 500;

async function runFollower(db: ImpQueries, parts: FollowerParts, head: number): Promise<void> {
  let cursor = head;

  while (!parts.signal.aborted) {
    // taken before the read, so a commit during the read still wakes the next wait
    const changed = parts.changes.next(parts.signal);

    try {
      const read = await readImpEventsAfter(db, { after: cursor, limit: READ_LIMIT });

      if (read.kind === 'reset') {
        getImpdLogger('events').warning("a prune passed impd's own followers at {seq}", {
          seq: read.prunedThrough,
        });

        cursor = read.prunedThrough;
        continue;
      }

      for (const event of read.events) {
        parts.followers.publish(event);
      }

      cursor = read.throughSeq;

      if (read.hasMore) {
        continue;
      }
    } catch (error) {
      getImpdLogger('events').warning("impd's own followers failed to read the log: {error}", {
        error: getErrorMessage(error),
      });
    }

    await changed;
  }
}
