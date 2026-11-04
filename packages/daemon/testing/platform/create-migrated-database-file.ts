import { Database } from 'bun:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { runMigrationsTo } from '../../src/platform/db/run-migrations';
import type { DB } from '../../src/platform/db/schema';
import { copyMigratedTemplate } from './copy-migrated-template';
import { probeProcessRunning } from './probe-process-running';
import { readMigrationsHash } from './read-migrations-hash';
import { readRunOwner } from './read-run-owner';

// on disk, not in tmpdir(), which is a tmpfs that holds each file in RAM on
// some hosts
const CACHE_DIRECTORY = join(import.meta.dir, '../../node_modules/.cache/migrated-templates');

export async function createMigratedDatabaseFile(path: string, migration: string): Promise<void> {
  await copyMigratedTemplate(path, migration, {
    cacheDirectory: CACHE_DIRECTORY,
    migrationsHash: readMigrationsHash(join(import.meta.dir, '../../src/platform/db')),
    owner: readRunOwner(),
    now: Date.now,
    probeProcessRunning,
    fileSystem: {
      copyFileSync,
      existsSync,
      mkdirSync,
      readdirSync,
      renameSync,
      rmSync,
      statSync,
    },
    writeTemplate,
  });
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
