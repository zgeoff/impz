// Each migration types the database as it stood when the migration ran, never
// as today's schema, so a later column change cannot break an older migration.
export type NoTables = Record<string, never>;
