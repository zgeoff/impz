import type { Migration } from 'kysely/migration';
import { DURABLE_MIGRATION_001_CREATE_EVENT_LOG } from './durable-migration-001-create-event-log';
import { DURABLE_MIGRATION_002_CREATE_OPERATIONS } from './durable-migration-002-create-operations';
import { DURABLE_MIGRATION_003_CREATE_RECONCILERS } from './durable-migration-003-create-reconcilers';

export const durableMigrations: Readonly<Record<string, Migration>> = {
  durable_001_create_event_log: DURABLE_MIGRATION_001_CREATE_EVENT_LOG,
  durable_002_create_operations: DURABLE_MIGRATION_002_CREATE_OPERATIONS,
  durable_003_create_reconcilers: DURABLE_MIGRATION_003_CREATE_RECONCILERS,
};
