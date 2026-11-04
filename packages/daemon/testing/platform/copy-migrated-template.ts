import type {
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
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { match } from 'ts-pattern';
import { collectStaleTemplateFiles } from './collect-stale-template-files';
import type { TemplateFile } from './is-stale-template-file';
import { pickTemplateStep } from './pick-template-step';
import type { TemplateStep } from './pick-template-step';

interface TemplateFileSystem {
  readonly copyFileSync: typeof copyFileSync;
  readonly existsSync: typeof existsSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly readdirSync: typeof readdirSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly statSync: typeof statSync;
  readonly utimesSync: typeof utimesSync;
  readonly writeFileSync: typeof writeFileSync;
}

export interface TemplateDependencies {
  readonly cacheDirectory: string;
  readonly migrationsHash: string;
  readonly owner: { readonly pid: number; readonly namespace: string };
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly probeProcessRunning: (pid: number) => boolean;
  readonly fileSystem: TemplateFileSystem;
  readonly writeTemplate: (path: string, migration: string) => Promise<void>;
}

export async function copyMigratedTemplate(
  path: string,
  migration: string,
  dependencies: TemplateDependencies,
): Promise<void> {
  dependencies.fileSystem.mkdirSync(dependencies.cacheDirectory, { recursive: true });

  const template = join(
    dependencies.cacheDirectory,
    `${migration}-${dependencies.migrationsHash}.sqlite`,
  );

  let copied = false;

  while (!copied) {
    const step = readTemplateStep(template, dependencies);

    copied = await match(step)
      .with('reuse', () => writeTemplateCopy(template, path, dependencies))
      .with('build', () => runTemplateBuild(template, migration, dependencies).then(() => false))
      .with('remove-lock', () => {
        dependencies.fileSystem.rmSync(`${template}.lock`, { force: true });

        return false;
      })
      .with('wait', () => dependencies.sleep(10).then(() => false))
      .exhaustive();
  }
}

function readTemplateStep(template: string, dependencies: TemplateDependencies): TemplateStep {
  const lock = `${template}.lock`;

  const lockFile = dependencies.fileSystem.existsSync(lock)
    ? readTemplateFile(lock, dependencies)
    : null;

  return pickTemplateStep(
    dependencies.fileSystem.existsSync(template),
    lockFile,
    dependencies.migrationsHash,
  );
}

function readTemplateFile(path: string, dependencies: TemplateDependencies): TemplateFile | null {
  const stats = dependencies.fileSystem.statSync(path, { throwIfNoEntry: false });

  if (stats === undefined) {
    return null;
  }

  const name = basename(path);
  const ownerText = name.endsWith('.lock') ? readLockOwner(path, dependencies) : name;
  const owner = parseRunOwner(ownerText);

  return {
    name,
    ageMs: dependencies.now() - stats.mtimeMs,
    isOwnerGone:
      owner?.namespace === dependencies.owner.namespace &&
      !dependencies.probeProcessRunning(owner.pid),
  };
}

function readLockOwner(lock: string, dependencies: TemplateDependencies): string {
  try {
    return dependencies.fileSystem.readFileSync(lock, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return '';
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
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

// a sweep in another run can remove a template of older migrations between
// the step's read and the copy; a copy that opened the file reads it whole
// even after its removal, so only a copy that found no file builds again
function writeTemplateCopy(
  template: string,
  path: string,
  dependencies: TemplateDependencies,
): boolean {
  const now = new Date(dependencies.now());

  try {
    dependencies.fileSystem.utimesSync(template, now, now);
    dependencies.fileSystem.copyFileSync(template, path);

    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

async function runTemplateBuild(
  template: string,
  migration: string,
  dependencies: TemplateDependencies,
): Promise<void> {
  const owner = `pid${String(dependencies.owner.pid)}-ns${dependencies.owner.namespace}`;
  const lock = `${template}.lock`;

  if (!createLock(lock, owner, dependencies)) {
    await dependencies.sleep(10);

    return;
  }

  const building = join(dirname(template), `${owner}-${basename(template)}`);

  try {
    await dependencies.writeTemplate(building, migration);

    dependencies.fileSystem.renameSync(building, template);
  } finally {
    dependencies.fileSystem.rmSync(building, { force: true });
    dependencies.fileSystem.rmSync(lock, { force: true });
  }

  removeStaleTemplateFiles(dependencies);
}

function createLock(lock: string, owner: string, dependencies: TemplateDependencies): boolean {
  try {
    dependencies.fileSystem.writeFileSync(lock, owner, { flag: 'wx' });

    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }

    throw error;
  }
}

function removeStaleTemplateFiles(dependencies: TemplateDependencies): void {
  const files = dependencies.fileSystem
    .readdirSync(dependencies.cacheDirectory)
    .map((name) => readTemplateFile(join(dependencies.cacheDirectory, name), dependencies))
    .filter((file): file is TemplateFile => file !== null);

  for (const file of collectStaleTemplateFiles(files, dependencies.migrationsHash)) {
    dependencies.fileSystem.rmSync(join(dependencies.cacheDirectory, file.name), { force: true });
  }
}
