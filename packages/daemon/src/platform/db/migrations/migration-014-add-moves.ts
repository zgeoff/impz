import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// moves between hosts (docs/guides/hosts.md#moves)
export const MIGRATION_014_ADD_MOVES: Migration = {
  async up(db: Kysely<NoTables>) {
    // set while the imp moves between hosts: nothing wakes or changes it
    await db.schema.alterTable('imps').addColumn('move_state', 'text').execute();

    // The target's side of a move: one receive ticket. Only the ticket's sha256
    // is kept. The stream must start by stream_by; the commit is good until
    // commit_until, set at the receipt.
    await db.schema
      .createTable('move_tickets')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('secret_sha256', 'text', (c) => c.notNull().unique())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('bytes', 'integer', (c) => c.notNull())

      // the imp the stream staged, once it started
      .addColumn('imp_id', 'text')
      .addColumn('issued_at', 'integer', (c) => c.notNull())
      .addColumn('stream_by', 'integer', (c) => c.notNull())
      .addColumn('stream_used_at', 'integer')

      // the receipt as sent, JSON
      .addColumn('receipt', 'text')
      .addColumn('commit_until', 'integer')
      .addColumn('committed_at', 'integer')
      .execute();

    // The source's side of a move: the target's URL and ticket, kept so a
    // restart can finish the commit, and the receipt once it came
    await db.schema
      .createTable('move_sends')
      .addColumn('imp_id', 'text', (c) => c.primaryKey())
      .addColumn('peer_url', 'text')
      .addColumn('ticket', 'text')
      .addColumn('total_bytes', 'integer', (c) => c.notNull())

      // how the disk goes: `files`, or `zfs` streams to a ZFS target
      .addColumn('mode', 'text', (c) => c.notNull().defaultTo('files'))
      .addColumn('receipt', 'text')
      .addColumn('error', 'text')
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();
  },
};
