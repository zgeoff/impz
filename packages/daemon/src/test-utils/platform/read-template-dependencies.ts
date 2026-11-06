import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { runMigrationsTo } from '../../platform/db/run-migrations';
import type { DB } from '../../platform/db/schema';
import type { TemplateDependencies } from './copy-migrated-template';
import { probeProcessRunning } from './probe-process-running';
import { readMigrationsHash } from './read-migrations-hash';
import { readRunOwner } from './read-run-owner';

export function readTemplateDependencies(cacheDirectory: string): TemplateDependencies {
  return {
    cacheDirectory,
    migrationsHash: readMigrationsHash(join(import.meta.dir, '../../platform/db')),
    owner: readRunOwner(),
    now: Date.now,
    createBuildID: randomUUID,
    probeProcessRunning,
    fileSystem: {
      copyFileSync,
      existsSync,
      mkdirSync,
      readdirSync,
      renameSync,
      rmSync,
      statSync,
      writeFileSync,
    },
    writeTemplate,
  };
}

async function writeTemplate(path: string, migration: string): Promise<void> {
  const sqlite = new Database(path, { create: true });

  // a sync on each migration's commit takes seconds on a busy disk, and a
  // template never needs to survive a power loss
  sqlite.run('PRAGMA synchronous = OFF;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const db = new Kysely<DB>({ dialect: buildSQLiteDialect(sqlite) });

  try {
    await runMigrationsTo(db, migration);
  } finally {
    await db.destroy();

    sqlite.close();
  }
}
