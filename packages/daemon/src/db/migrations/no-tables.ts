// Each migration types the database as it stood when the migration ran, never
// as today's schema.ts, so a later column change cannot break an older
// migration. Timestamps are integer milliseconds since the epoch.
export type NoTables = Record<string, never>;
