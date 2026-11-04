import { randomUUID } from 'node:crypto';
import type {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { collectStaleTemplateFiles } from './collect-stale-template-files';
import type { TemplateFile } from './is-stale-template-file';
import { isTemplateGoneError } from './is-template-gone-error';

interface TemplateFileSystem {
  readonly copyFileSync: typeof copyFileSync;
  readonly existsSync: typeof existsSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly readdirSync: typeof readdirSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly statSync: typeof statSync;
}

export interface TemplateDependencies {
  readonly cacheDirectory: string;
  readonly migrationsHash: string;
  readonly owner: { readonly pid: number; readonly namespace: string };
  readonly now: () => number;
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
    if (!dependencies.fileSystem.existsSync(template)) {
      await runTemplateBuild(template, migration, dependencies);
    }

    copied = writeTemplateCopy(template, path, dependencies);
  }
}

// each build writes a file of its own and renames it into place, so a copy
// never sees half a template, and two builds that race write the same schema
async function runTemplateBuild(
  template: string,
  migration: string,
  dependencies: TemplateDependencies,
): Promise<void> {
  const owner = `pid${String(dependencies.owner.pid)}-ns${dependencies.owner.namespace}`;
  const building = join(dirname(template), `${owner}-${randomUUID()}-${basename(template)}`);

  try {
    await dependencies.writeTemplate(building, migration);

    dependencies.fileSystem.renameSync(building, template);
  } finally {
    dependencies.fileSystem.rmSync(building, { force: true });
  }

  removeStaleTemplateFiles(dependencies);
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

function readTemplateFile(path: string, dependencies: TemplateDependencies): TemplateFile | null {
  const stats = dependencies.fileSystem.statSync(path, { throwIfNoEntry: false });

  if (stats === undefined) {
    return null;
  }

  const name = basename(path);
  const owner = parseBuildOwner(name);

  return {
    name,
    ageMs: dependencies.now() - stats.mtimeMs,
    isOwnerGone:
      owner?.namespace === dependencies.owner.namespace &&
      !dependencies.probeProcessRunning(owner.pid),
  };
}

function parseBuildOwner(name: string): { pid: number; namespace: string } | null {
  const groups = /^pid(?<pid>\d+)-ns(?<namespace>\d+)-/u.exec(name)?.groups;
  const pid = groups?.['pid'];
  const namespace = groups?.['namespace'];

  if (pid === undefined || namespace === undefined) {
    return null;
  }

  return { pid: Number(pid), namespace };
}

// a sweep in another run can remove a template of older migrations between
// the check and the copy; a copy that opened the file reads it whole
function writeTemplateCopy(
  template: string,
  path: string,
  dependencies: TemplateDependencies,
): boolean {
  try {
    dependencies.fileSystem.copyFileSync(template, path);

    return true;
  } catch (error) {
    if (isTemplateGoneError(error, dependencies.fileSystem.existsSync(dirname(path)))) {
      return false;
    }

    throw error;
  }
}
