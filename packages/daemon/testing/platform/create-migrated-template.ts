import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { match } from 'ts-pattern';
import { runMigrationsTo } from '../../src/platform/db/run-migrations';
import type { DB } from '../../src/platform/db/schema';
import { isStaleTemplateFile } from './is-stale-template-file';
import type { TemplateFile } from './is-stale-template-file';
import { pickTemplateStep } from './pick-template-step';
import type { TemplateStep } from './pick-template-step';

export interface TemplateDependencies {
  readonly owner: { readonly pid: number; readonly namespace: string };
  readonly now: () => number;
  readonly probeProcessRunning: (pid: number) => boolean;
}

export async function createMigratedTemplate(
  cacheDirectory: string,
  migration: string,
  dependencies: TemplateDependencies,
): Promise<string> {
  mkdirSync(cacheDirectory, { recursive: true });

  const hash = readMigrationsHash();
  const template = join(cacheDirectory, `${migration}-${hash}.sqlite`);
  const lock = `${template}.lock`;

  for (
    let step = readTemplateStep(template, lock, hash, dependencies);
    step !== 'reuse';
    step = readTemplateStep(template, lock, hash, dependencies)
  ) {
    await match(step)
      .with('build', () => runTemplateBuild(template, migration, hash, dependencies))
      .with('remove-lock', () => {
        rmSync(lock, { force: true });
      })
      .with('wait', () => Bun.sleep(10))
      .exhaustive();
  }

  // a sweep keeps a template that a run used in the last hour
  const now = new Date(dependencies.now());

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

function readTemplateStep(
  template: string,
  lock: string,
  hash: string,
  dependencies: TemplateDependencies,
): TemplateStep {
  const lockFile = readTemplateFile(lock, dependencies);

  return pickTemplateStep(existsSync(template), lockFile, hash);
}

function readTemplateFile(path: string, dependencies: TemplateDependencies): TemplateFile | null {
  const modifiedMs = readModifiedMs(path);

  if (modifiedMs === null) {
    return null;
  }

  const name = basename(path);
  const ownerText = name.endsWith('.lock') ? readLockOwner(path) : name;
  const owner = parseRunOwner(ownerText);

  return {
    name,
    ageMs: dependencies.now() - modifiedMs,
    isOwnerGone:
      owner?.namespace === dependencies.owner.namespace &&
      !dependencies.probeProcessRunning(owner.pid),
  };
}

function readModifiedMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function readLockOwner(lock: string): string {
  try {
    return readFileSync(lock, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
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

async function runTemplateBuild(
  template: string,
  migration: string,
  hash: string,
  dependencies: TemplateDependencies,
): Promise<void> {
  const owner = `pid${String(dependencies.owner.pid)}-ns${dependencies.owner.namespace}`;
  const lock = `${template}.lock`;

  // another run took the lock first, so the next step waits for its build
  if (!createLock(lock, owner)) {
    return;
  }

  const building = join(dirname(template), `${owner}-${basename(template)}`);

  try {
    await writeTemplate(building, migration);

    renameSync(building, template);
  } finally {
    rmSync(building, { force: true });
    rmSync(lock, { force: true });
  }

  removeStaleTemplateFiles(dirname(template), hash, dependencies);
}

function createLock(lock: string, owner: string): boolean {
  try {
    writeFileSync(lock, owner, { flag: 'wx' });

    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
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

function removeStaleTemplateFiles(
  cacheDirectory: string,
  hash: string,
  dependencies: TemplateDependencies,
): void {
  const stale = readdirSync(cacheDirectory)
    .map((name) => readTemplateFile(join(cacheDirectory, name), dependencies))
    .filter((file): file is TemplateFile => file !== null && isStaleTemplateFile(file, hash));

  for (const file of stale) {
    rmSync(join(cacheDirectory, file.name), { force: true });
  }
}
