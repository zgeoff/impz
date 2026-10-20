import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LAYER_TABLE, planLayerPath } from './plan-layer-path';
import { transformLayerPaths } from './transform-layer-paths';

const DAEMON_SRC = LAYER_TABLE.daemonSrc;

// every path is relative to the repository root
export interface LayerReport {
  readonly moved: readonly (readonly [from: string, to: string])[];
  readonly rewritten: readonly string[];

  // the files under src that no move and no root stem covers, to add to the layer table
  readonly unplaced: readonly string[];

  // the moves whose destination already holds a file, or another move's file; any one of them
  // stops the run before it changes a file
  readonly collisions: readonly (readonly [from: string, to: string])[];
}

// `files` are the repository's text files relative to `root`, before the move
export function applyLayerMoves(root: string, files: readonly string[]): LayerReport {
  const moves = new Map<string, string>();

  for (const file of files) {
    const target = planRepoPath(file);

    if (target !== file && existsSync(join(root, file))) {
      moves.set(file, target);
    }
  }

  const collisions = [...moves].filter(
    ([from, to]) =>
      existsSync(join(root, to)) ||
      [...moves].some(([other, otherTo]) => other !== from && otherTo === to),
  );

  if (collisions.length > 0) {
    return { moved: [], rewritten: [], unplaced: [], collisions };
  }

  for (const [from, to] of moves) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(join(root, from), join(root, to));
  }

  removeEmptyFolders(root, [...moves.keys()]);

  const rewritten = files.flatMap((file) => {
    const current = moves.get(file) ?? file;

    return updateFilePaths(root, file, current) ? [current] : [];
  });

  return {
    moved: [...moves],
    rewritten,
    unplaced: files
      .map((file) => moves.get(file) ?? file)
      .filter((file) => file.startsWith(`${DAEMON_SRC}/`) && !isCovered(file)),
    collisions: [],
  };
}

function planRepoPath(file: string): string {
  if (!file.startsWith(`${DAEMON_SRC}/`)) {
    return file;
  }

  return `${DAEMON_SRC}/${planLayerPath(file.slice(DAEMON_SRC.length + 1))}`;
}

function isCovered(file: string): boolean {
  const path = file.slice(DAEMON_SRC.length + 1);

  const isRoot =
    !path.includes('/') && LAYER_TABLE.rootStems.some((stem) => path.startsWith(`${stem}.`));

  return isRoot || (LAYER_TABLE.layers as readonly string[]).includes(path.split('/')[0] ?? '');
}

// removes each folder that a move emptied, up to src
function removeEmptyFolders(root: string, movedFrom: readonly string[]): void {
  const folders = new Set(movedFrom.map((file) => dirname(file)));

  for (const start of [...folders].toSorted((a, b) => b.length - a.length)) {
    for (
      let folder = start;
      folder.startsWith(`${DAEMON_SRC}/`) &&
      existsSync(join(root, folder)) &&
      readdirSync(join(root, folder)).length === 0;
      folder = dirname(folder)
    ) {
      rmdirSync(join(root, folder));
    }
  }
}

// rewrites the paths in `file`, which now sits at `current`; true when its text changed
function updateFilePaths(root: string, file: string, current: string): boolean {
  const text = readText(join(root, current));

  if (text === null) {
    return false;
  }

  const next = transformLayerPaths(text, { root, file, current });

  if (next === text) {
    return false;
  }

  writeFileSync(join(root, current), next);

  return true;
}

// null for a file that is gone or binary (a NUL byte), which holds no path to rewrite
function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }

  const bytes = readFileSync(path);

  return bytes.includes(0) ? null : bytes.toString('utf8');
}
