import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import * as z from 'zod';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildConflictError } from '../../surface/api-errors';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { ImpQueries } from './open-database';

export interface DatabaseCopyFile {
  readonly path: string;
  readonly sizeBytes: number;

  readonly lastMigration: string;
  readonly createdAt: Date;

  readonly integrity: string;
}

const MigrationRowSchema = z.object({ name: z.string() });
const IntegrityRowSchema = z.object({ integrity_check: z.string() });
const SizeRowSchema = z.object({ bytes: z.int().nonnegative() });

// VACUUM INTO copies in one read transaction, so the copy is whole whatever
// writes run meanwhile; its target must be absent or empty.
export async function writeConsistentCopy(db: ImpQueries, path: string): Promise<void> {
  await sql`VACUUM INTO ${path}`.execute(db);
}

function buildDatabaseCopyPath(dataDir: string, name: string): string {
  return join(dataDir, 'db-copies', `${name}.sqlite`);
}

export interface WriteDatabaseCopyOptions {
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly dataDir: string;
  readonly name: string;
  readonly now: () => number;
}

export async function writeDatabaseCopy(
  db: ImpQueries,
  options: WriteDatabaseCopyOptions,
): Promise<DatabaseCopyFile> {
  const dataDir = options.dataDir;
  const name = options.name;
  const path = buildDatabaseCopyPath(dataDir, name);
  const directory = join(dataDir, 'db-copies');

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  // mkdirSync leaves a directory that was there as it was
  chmodSync(directory, 0o700);

  const sizeBytes = await readDatabaseBytes(db);

  return options.diskBudget.withRoom(sizeBytes, async () => {
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw buildConflictError('database-copy', name);
      }

      throw error;
    }

    try {
      await writeConsistentCopy(db, path);

      return {
        path,
        sizeBytes: statSync(path).size,
        ...readCopyFacts(path),
        createdAt: new Date(options.now()),
      };
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  });
}

async function readDatabaseBytes(db: ImpQueries): Promise<number> {
  const result = await sql<{
    bytes: number;
  }>`SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()`.execute(
    db,
  );

  return SizeRowSchema.parse(result.rows[0]).bytes;
}

function readCopyFacts(path: string): Pick<DatabaseCopyFile, 'lastMigration' | 'integrity'> {
  const copy = new Database(path, { readonly: true });

  try {
    const row = copy.query('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1').get();
    const check = copy.query('PRAGMA integrity_check').get();

    return {
      lastMigration: MigrationRowSchema.parse(row).name,
      integrity: IntegrityRowSchema.parse(check).integrity_check,
    };
  } finally {
    copy.close();
  }
}
