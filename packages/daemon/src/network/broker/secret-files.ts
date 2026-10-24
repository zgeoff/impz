import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileDurably } from '../../platform/process/write-file-durably';
import type { KeptSecretFiles } from '../../vm/storage/kept-secret-files';

// values sit unencrypted: the key would live on the same disk
export interface SecretFiles extends KeptSecretFiles {
  readonly write: (file: string, value: string) => void;

  readonly rewrite: (file: string, value: string) => void;

  readonly read: (file: string) => string | null;
  readonly remove: (file: string) => void;

  readonly keepOrphansExcept: (keep: ReadonlySet<string>, at: Date) => KeptOrphans;
}

const ORPHANED_DIR = '.orphaned';

interface KeptOrphans {
  readonly directory: string | null;
  readonly files: readonly string[];
}

export function buildValueFile(name: string): string {
  return `${name}.${randomBytes(8).toString('hex')}`;
}

interface SecretFilesOptions {
  readonly sync?: (fd: number) => void;
}

export function createSecretFiles(
  dataDir: string,
  options: Readonly<SecretFilesOptions> = {},
): SecretFiles {
  const directory = join(dataDir, 'secrets');
  const sync = options.sync ?? fsyncSync;

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  // mkdir leaves the mode of a directory that already exists alone
  chmodSync(directory, 0o700);

  return {
    // a temp file then a rename, so a reader never sees half a value, each
    // flushed to the disk, so an added secret outlives a power loss
    write: (file, value) => {
      writeFileDurably(join(directory, file), value, { mode: 0o600, sync });
    },
    rewrite: (file, value) => {
      writeFileDurably(join(directory, file), value, { mode: 0o600, sync });
    },
    read: (file) => {
      try {
        return readFileSync(join(directory, file), 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      }
    },
    remove: (file) => {
      rmSync(join(directory, file), { force: true });
    },
    keepOrphansExcept: (keep, at) => {
      const stamp = at.toISOString().replaceAll(':', '-');

      checkOrphansDirectory(join(directory, ORPHANED_DIR), `${ORPHANED_DIR}.${stamp}`);

      const files = readdirSync(directory)
        .filter((file) => file !== ORPHANED_DIR && !keep.has(file))
        .toSorted();

      if (files.length === 0) {
        return { directory: null, files };
      }

      // a time a path can hold: no colons
      const target = join(directory, ORPHANED_DIR, stamp);

      mkdirSync(target, { recursive: true, mode: 0o700 });
      chmodSync(join(directory, ORPHANED_DIR), 0o700);
      chmodSync(target, 0o700);

      for (const file of files) {
        renameSync(join(directory, file), join(target, file));
      }

      return { directory: target, files };
    },
    listKept: () => {
      const orphaned = join(directory, ORPHANED_DIR);

      if (!checkDirectory(orphaned)) {
        return [];
      }

      return readdirSync(orphaned)
        .toSorted()
        .filter((name) => checkDirectory(join(orphaned, name)))
        .map((name) => {
          const path = join(orphaned, name);
          const files = readdirSync(path).toSorted();
          const bytes = files.reduce((sum, file) => sum + lstatSync(join(path, file)).size, 0);

          return { name, path, bytes, createdAt: readStamp(name), files };
        });
    },
    removeKept: (name) => {
      if (name === '' || name.includes('/') || name === '.' || name === '..') {
        throw new Error(`not a kept directory: ${name}`);
      }

      rmSync(join(directory, ORPHANED_DIR, name), { recursive: true, force: true });
    },
  };
}

function checkDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function readStamp(name: string): Date | null {
  const iso = name.replace(/T(?<h>\d{2})-(?<m>\d{2})-(?<s>\d{2})/u, 'T$<h>:$<m>:$<s>');

  const at = new Date(iso);

  return Number.isNaN(at.getTime()) ? null : at;
}

// a file or a symlink at `path` would fail the start or take the chmod
// elsewhere, so it is renamed aside and kept with the other orphans
function checkOrphansDirectory(path: string, name: string): void {
  try {
    if (lstatSync(path).isDirectory()) {
      return;
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  renameSync(path, join(dirname(path), name));
}
