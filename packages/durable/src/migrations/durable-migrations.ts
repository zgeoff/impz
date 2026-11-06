import type { Migration } from 'kysely/migration';
import { DURABLE_MIGRATION_001_CREATE_EVENT_LOG } from './durable-migration-001-create-event-log';

export const durableMigrations: Readonly<Record<string, Migration>> = {
  durable_001_create_event_log: DURABLE_MIGRATION_001_CREATE_EVENT_LOG,
};
