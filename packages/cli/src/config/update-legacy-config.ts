import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const CONFIG_FILES: readonly string[] = ['config.json', 'token'];

export function updateLegacyConfig(
  directory: string,
  warn: (line: string) => void = console.error,
  reads: readonly string[] = CONFIG_FILES,
): void {
  const legacyDir = join(dirname(directory), 'imp');

  // impz's own file first, so a complete config never needs the old path
  const files = CONFIG_FILES.filter(
    (name) => !probePresent(join(directory, name)) && checkLegacyFile(join(legacyDir, name), warn),
  );

  if (files.length === 0) {
    return;
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  // physical paths, so a relative link resolves as the kernel resolves it even
  // when either directory is reached through a symlink
  const realLegacyDir = realpathSync(legacyDir);
  const realDir = realpathSync(directory);

  for (const name of files) {
    const from = join(legacyDir, name);
    const to = join(directory, name);

    try {
      writeMovedEntry(from, to, realLegacyDir, realDir);
    } catch (error) {
      if (reads.includes(name)) {
        throw error;
      }

      warn(`impz: cannot move ${from} to ${to}, so it stays there: ${String(error)}`);
      continue;
    }

    warn(`impz: moved ${from} to ${to}`);
  }

  try {
    rmdirSync(legacyDir);
  } catch {
    // not empty, or not ours to remove
  }
}

// lstat, so a symlink counts even when its target is gone
function probePresent(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

// a path that cannot be looked up is noted and left, so it never stops a call
// that reads impz's own config
function checkLegacyFile(path: string, warn: (line: string) => void): boolean {
  try {
    return probePresent(path);
  } catch (error) {
    // an `imp` that is a file, not a directory, holds no old config
    if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') {
      return false;
    }

    warn(`impz: cannot look for ${path} to move it: ${String(error)}`);

    return false;
  }
}

function writeMovedEntry(from: string, to: string, legacyDir: string, directory: string): void {
  if (lstatSync(from).isSymbolicLink()) {
    symlinkSync(planLinkTarget(readlinkSync(from), legacyDir, directory), to);
    removeMovedSource(from, to);
  } else {
    writeMovedFile(from, to);
  }
}

function planLinkTarget(target: string, legacyDir: string, directory: string): string {
  if (isAbsolute(target)) {
    return target;
  }

  const absolute = resolve(legacyDir, target);
  const isMoved = dirname(absolute) === legacyDir && CONFIG_FILES.includes(basename(absolute));
  const file = isMoved ? join(directory, basename(absolute)) : absolute;

  return relative(directory, file);
}

// the old file goes once its copy stands; when it cannot go, the copy goes
// instead, so the next call sees the move undone and tries it again
function removeMovedSource(from: string, to: string): void {
  try {
    unlinkSync(from);
  } catch (error) {
    unlinkSync(to);
    throw error;
  }
}

// a rename fails when the old directory is on another filesystem, so a copy
// takes its place
function writeMovedFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
      throw error;
    }

    // copied beside the target first, so a copy cut short never stands as
    // the moved file that a later call keeps
    const temp = `${to}.tmp`;

    copyFileSync(from, temp);
    chmodSync(temp, statSync(from).mode & 0o777);
    renameSync(temp, to);
    removeMovedSource(from, to);
  }
}
