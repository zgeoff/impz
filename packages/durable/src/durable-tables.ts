import type { Generated, Kysely } from 'kysely';

export interface EventsTable {
  readonly seq: Generated<number>;
  readonly at: number;
  readonly kind: string;
  readonly target_id: string | null;
  readonly operation_id: string | null;
  readonly payload: string;
}

export interface EventLogTable {
  readonly id: number;
  readonly log_id: string;
  readonly pruned_through: number;
}

export interface DurableTables {
  readonly events: EventsTable;
  readonly event_log: EventLogTable;
}

// a caller's Transaction<DB> fits this shape where it does not fit Kysely<DurableTables>
export type DurableQueries = Pick<
  Kysely<DurableTables>,
  'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
>;

// Kysely types isTransaction as true only on a Transaction, so a plain connection fails to fit
export type DurableTransaction = DurableQueries & { readonly isTransaction: true };
