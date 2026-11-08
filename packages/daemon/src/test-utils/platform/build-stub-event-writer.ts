import type { ImpEventLog } from '../../platform/db/create-imp-event-log';
import type { ImpLogEntry } from '../../platform/db/imp-log-entry';

export type WrittenEvent = ImpLogEntry & { readonly at: number };

// in place of the event log, for a unit that only writes events: it keeps each write in order
export function buildStubEventWriter(): Pick<ImpEventLog, 'write'> & {
  readonly written: readonly WrittenEvent[];
} {
  const written: WrittenEvent[] = [];

  return {
    written,
    write: (entry, at) => {
      written.push({ ...entry, at });

      return Promise.resolve();
    },
  };
}
