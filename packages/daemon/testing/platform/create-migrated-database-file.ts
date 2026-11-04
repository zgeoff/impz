import { Database } from 'bun:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { runMigrationsTo } from '../../src/platform/db/run-migrations';
import type { DB } from '../../src/platform/db/schema';
import { copyMigratedTemplate } from './copy-migrated-template';

// on disk, not in tmpdir(), which is a tmpfs that holds each file in RAM on
// some hosts
const CACHE_DIRECTORY = join(import.meta.dir, '../../node_modules/.cache/migrated-templates');

export async function createMigratedDatabaseFile(path: string, migration: string): Promise<void> {
  await copyMigratedTemplate(path, migration, {
    cacheDirectory: CACHE_DIRECTORY,
    migrationsHash: readMigrationsHash(),
    owner: { pid: process.pid, namespace: readPidNamespace() },
    now: Date.now,
    sleep: Bun.sleep,
    probeProcessRunning,
    fileSystem: {
      copyFileSync,
      existsSync,
      mkdirSync,
      readFileSync,
      readdirSync,
      renameSync,
      rmSync,
      statSync,
      utimesSync,
      writeFileSync,
    },
    writeTemplate,
  });
}

const DB_DIRECTORY = join(import.meta.dir, '../../src/platform/db');

function readMigrationsHash(): string {
  const hasher = new Bun.CryptoHasher('sha256');

  const migrations = readdirSync(join(DB_DIRECTORY, 'migrations'))
    .toSorted()
    .map((name) => join('migrations', name));

  for (const file of ['run-migrations.ts', ...migrations]) {
    hasher.update(file);
    hasher.update(readFileSync(join(DB_DIRECTORY, file)));
  }

  return hasher.digest('hex').slice(0, 16);
}

// the PID namespace tells a run in this sandbox from one in another sandbox
// that shares the folder and reuses the same PIDs
function readPidNamespace(): string {
  return readlinkSync('/proc/self/ns/pid').replaceAll(/\D/gu, '');
}

function probeProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
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
