import { Database } from 'bun:sqlite';
import {
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
import { basename, join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { runMigrationsTo } from '../../src/platform/db/run-migrations';
import type { DB } from '../../src/platform/db/schema';
import { isStaleTemplateFile } from './is-stale-template-file';
import type { TemplateFile } from './is-stale-template-file';

export async function createMigratedTemplate(
  cacheDirectory: string,
  migration: string,
): Promise<string> {
  mkdirSync(cacheDirectory, { recursive: true });

  const hash = readMigrationsHash();
  const template = join(cacheDirectory, `${migration}-${hash}.sqlite`);
  const lock = `${template}.lock`;
  const namespace = readPidNamespace();
  const owner = `pid${String(process.pid)}-ns${namespace}`;

  while (!existsSync(template)) {
    if (createLock(lock, owner)) {
      const building = join(cacheDirectory, `${owner}-${basename(template)}`);

      try {
        await writeTemplate(building, migration);

        renameSync(building, template);
      } finally {
        rmSync(building, { force: true });
        rmSync(lock, { force: true });
      }

      removeStaleTemplateFiles(cacheDirectory, hash, namespace);
    } else if (probeStaleTemplateFile(cacheDirectory, basename(lock), hash, namespace)) {
      rmSync(lock, { force: true });
    } else {
      await Bun.sleep(10);
    }
  }

  // a sweep keeps a template that a run used in the last hour
  const now = new Date();

  utimesSync(template, now, now);

  return template;
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

function createLock(lock: string, owner: string): boolean {
  try {
    writeFileSync(lock, owner, { flag: 'wx' });

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false;
    }

    throw error;
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

function removeStaleTemplateFiles(cacheDirectory: string, hash: string, namespace: string): void {
  for (const name of readdirSync(cacheDirectory)) {
    if (probeStaleTemplateFile(cacheDirectory, name, hash, namespace)) {
      rmSync(join(cacheDirectory, name), { force: true });
    }
  }
}

function probeStaleTemplateFile(
  cacheDirectory: string,
  name: string,
  hash: string,
  namespace: string,
): boolean {
  const file = readTemplateFile(cacheDirectory, name, namespace);

  return file !== null && isStaleTemplateFile(file, hash);
}

function readTemplateFile(
  cacheDirectory: string,
  name: string,
  namespace: string,
): TemplateFile | null {
  const path = join(cacheDirectory, name);
  const modifiedMs = readModifiedMs(path);

  if (modifiedMs === null) {
    return null;
  }

  const ownerText = name.endsWith('.lock') ? readLockOwner(path) : name;
  const owner = parseRunOwner(ownerText);

  return {
    name,
    ageMs: Date.now() - modifiedMs,
    isOwnerGone: owner?.namespace === namespace && !probeProcessRunning(owner.pid),
  };
}

function readModifiedMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function readLockOwner(lock: string): string {
  try {
    return readFileSync(lock, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return '';
    }

    throw error;
  }
}

// a lock holds its owner, and a build's files start with it
function parseRunOwner(text: string): { pid: number; namespace: string } | null {
  const groups = /^pid(?<pid>\d+)-ns(?<namespace>\d+)(?:-|$)/u.exec(text)?.groups;
  const pid = groups?.['pid'];
  const namespace = groups?.['namespace'];

  if (pid === undefined || namespace === undefined) {
    return null;
  }

  return { pid: Number(pid), namespace };
}

function probeProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
