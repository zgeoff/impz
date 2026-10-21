import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import tar from 'tar-stream';
import type { Header } from 'tar-stream';
import * as z from 'zod';

export interface LocalExtractor {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly end: () => Promise<number>;
}

export interface ExtractProgress {
  readonly setTotal: (bytes: number) => void;
  readonly add: (bytes: number) => void;
}

interface PendingDir {
  readonly path: string;
  readonly mode: number;
  readonly mtime: Date;
}

interface PendingSymlink {
  readonly name: string;
  readonly path: string;
  readonly target: string;
}

interface CopyRoot {
  readonly path: string;
  readonly top: string;
}

type ExtractOutcome = { readonly refused: number } | { readonly error: Error };

class RefusedError extends Error {
  override name = 'RefusedError';
}

export function createLocalExtractor(
  destination: string,
  progress: ExtractProgress,
  warn: (text: string) => void,
  totalRecord: string,
): LocalExtractor {
  const extract = tar.extract();
  const dirs: PendingDir[] = [];
  const links: PendingSymlink[] = [];

  const state = {
    root: null as CopyRoot | null,
    refused: 0,
    temps: 0,
    first: true,
    stopped: false,
  };

  const drainWaiters: (() => void)[] = [];

  const wakeDrainWaiters = (): void => {
    for (const wake of drainWaiters.splice(0)) {
      wake();
    }
  };

  // An error event with no listener throws; end reports the error instead.
  extract.on('error', () => {});
  extract.on('drain', wakeDrainWaiters);
  extract.on('close', wakeDrainWaiters);

  const buildTempPath = (path: string): string => {
    state.temps += 1;

    return join(dirname(path), `.imp-cp-${String(process.pid)}-${String(state.temps)}`);
  };

  const requireRoot = async (top: string): Promise<CopyRoot> => {
    if (state.root === null) {
      state.root = await resolveCopyRoot(destination, top);
    } else if (top !== state.root.top) {
      throw new RefusedError(`outside the copy's top ${state.root.top}`);
    }

    return state.root;
  };

  const makeDir = async (path: string, header: Readonly<Header>): Promise<void> => {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      const existing = await lstat(path).catch(() => null);

      if (readErrorCode(error) === 'EEXIST' && existing?.isDirectory() === true) {
        return;
      }

      throw error;
    }

    dirs.push({ path, mode: header.mode, mtime: header.mtime });
  };

  const writeFile = async (
    path: string,
    header: Readonly<Header>,
    content: Readonly<AsyncIterable<unknown>>,
  ): Promise<void> => {
    const temp = buildTempPath(path);

    const handle = await open(temp, 'wx', 0o600);

    try {
      for await (const chunk of content) {
        if (chunk instanceof Uint8Array) {
          progress.add(chunk.byteLength);

          await handle.write(chunk);
        }
      }

      await handle.close();

      await chmod(temp, toSafeMode(header.mode));
      await utimes(temp, header.mtime, header.mtime);
      await rename(temp, path);
    } catch (error) {
      await handle.close().catch(() => null);

      await unlink(temp).catch(() => null);

      throw error;
    }
  };

  const makeHardLink = async (root: CopyRoot, path: string, linkname: string): Promise<void> => {
    const [top, rest] = splitEntryName(linkname);

    if (top !== root.top) {
      throw new RefusedError(`a hard link to ${linkname}, outside the copy`);
    }

    const existing = join(root.path, rest);

    await checkParents(root.path, existing);

    const stats = await lstat(existing);

    if (!stats.isFile()) {
      throw new RefusedError(`a hard link to ${linkname}, not a file`);
    }

    await link(existing, path);
  };

  const writeEntry = async (
    header: Readonly<Header>,
    content: Readonly<AsyncIterable<unknown>>,
  ): Promise<void> => {
    const [top, rest] = splitEntryName(header.name);

    const root = await requireRoot(top);

    const path = rest === '' ? root.path : join(root.path, rest);

    await checkParents(root.path, path);

    if (header.type === 'directory') {
      await makeDir(path, header);
    } else if (header.type === 'file') {
      await writeFile(path, header, content);
    } else if (header.type === 'symlink') {
      links.push({ name: header.name, path, target: header.linkname });
    } else if (header.type === 'link') {
      await makeHardLink(root, path, header.linkname);
    } else {
      warn(`${header.name}: not a file, directory or link; skipped`);
    }
  };

  const makeSymlink = async (root: CopyRoot, pending: PendingSymlink): Promise<void> => {
    await checkParents(root.path, pending.path);

    const temp = buildTempPath(pending.path);

    await symlink(pending.target, temp);

    try {
      await rename(temp, pending.path);
    } catch (error) {
      await unlink(temp).catch(() => null);

      throw error;
    }
  };

  // Deepest first, so a change inside a child does not move its parent's time.
  const applyDirModes = async (): Promise<void> => {
    const sorted = dirs.toSorted(
      (left, right) => right.path.split('/').length - left.path.split('/').length,
    );

    for (const directory of sorted) {
      await chmod(directory.path, toSafeMode(directory.mode));
      await utimes(directory.path, directory.mtime, directory.mtime);
    }
  };

  const readEntries = async (): Promise<number> => {
    for await (const entry of extract) {
      const header = entry.header;

      if (state.first) {
        state.first = false;

        const total = z
          .object({ [totalRecord]: z.coerce.number().int().nonnegative() })
          .safeParse(header.pax);

        if (total.success) {
          progress.setTotal(total.data[totalRecord] ?? 0);
        }
      }

      try {
        await writeEntry(header, entry);
      } catch (error) {
        if (state.root === null) {
          throw error;
        }

        state.refused += 1;

        warn(`${header.name}: ${readMessage(error)}`);
      }

      entry.resume();
    }

    const root = state.root;

    if (root === null) {
      throw new Error('the imp sent an empty archive');
    }

    for (const pending of links) {
      try {
        await makeSymlink(root, pending);
      } catch (error) {
        state.refused += 1;

        warn(`${pending.name}: ${readMessage(error)}`);
      }
    }

    await applyDirModes();

    return state.refused;
  };

  const runExtract = async (): Promise<ExtractOutcome> => {
    try {
      const refused = await readEntries();

      return { refused };
    } catch (error) {
      state.stopped = true;

      wakeDrainWaiters();

      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  };

  const outcome = runExtract();

  return {
    write: async (chunk) => {
      if (state.stopped || extract.write(chunk)) {
        return;
      }

      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
    end: async () => {
      extract.end(null);

      const done = await outcome;

      if ('error' in done) {
        throw done.error;
      }

      return done.refused;
    },
  };
}

// Matches cp -r.
async function resolveCopyRoot(destination: string, top: string): Promise<CopyRoot> {
  const destStats = await stat(destination).catch(() => null);

  const path = destStats?.isDirectory() === true ? join(destination, top) : destination;

  const rootStats = await lstat(path).catch(() => null);

  if (rootStats?.isSymbolicLink() === true) {
    throw new Error(`${path} is a symlink; the copy will not go through it`);
  }

  return { path, top };
}

function readErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function toSafeMode(mode: number): number {
  return mode & 0o1777;
}

function splitEntryName(name: string): readonly [string, string] {
  if (name.startsWith('/')) {
    throw new RefusedError('an absolute name');
  }

  const parts = name.split('/').filter((part) => part !== '' && part !== '.');

  if (parts.includes('..')) {
    throw new RefusedError('a name with ".."');
  }

  const [top, ...rest] = parts;

  if (top === undefined) {
    throw new RefusedError('an empty name');
  }

  return [top, rest.join('/')];
}

async function checkParents(root: string, path: string): Promise<void> {
  const below = path
    .slice(root.length)
    .split('/')
    .filter((part) => part !== '');

  let current = root;

  for (const part of below.slice(0, -1)) {
    current = join(current, part);

    const stats = await lstat(current).catch(() => null);

    if (stats === null) {
      throw new RefusedError(`${current} is missing`);
    }

    if (!stats.isDirectory()) {
      throw new RefusedError(`under ${current}, which is not a directory`);
    }
  }
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
