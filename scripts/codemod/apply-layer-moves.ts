import { isUtf8 } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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

  const plans = [...moves].map(([from, to]) => planMove(root, from, to));

  const collisions = plans
    .filter(
      (plan) =>
        isTakenByOther(root, plan) ||
        plans.some((other) => other.from !== plan.from && other.to === plan.to),
    )
    .map((plan) => [plan.from, plan.to] as const);

  if (collisions.length > 0) {
    return { moved: [], rewritten: [], unplaced: [], collisions };
  }

  // each file moves with its text already rewritten, so a run that stops part way leaves every
  // file consistent with its own folder, and the next run carries on from there
  for (const plan of plans) {
    if (!existsSync(join(root, plan.to))) {
      mkdirSync(dirname(join(root, plan.to)), { recursive: true });

      if (plan.next === null || plan.next === plan.text) {
        renameSync(join(root, plan.from), join(root, plan.to));
      } else {
        writeFileSync(join(root, plan.to), plan.next, { mode: plan.mode });
      }
    }

    rmSync(join(root, plan.from), { force: true });
  }

  removeEmptyFolders(root, [...moves.keys()]);

  const relinked = plans
    .filter((plan) => plan.next !== null && plan.next !== plan.text)
    .map((plan) => plan.to);

  const rewritten = files.flatMap((file) =>
    !moves.has(file) && updateFilePaths(root, file) ? [file] : [],
  );

  return {
    moved: [...moves],
    rewritten: [...relinked, ...rewritten],
    unplaced: files
      .map((file) => moves.get(file) ?? file)
      .filter((file) => file.startsWith(`${DAEMON_SRC}/`) && !isCovered(file)),
    collisions: [],
  };
}

// a file's move, with its text before and after its paths are rewritten from its old folder;
// both are null for a binary file, which moves as it is
interface MovePlan {
  readonly from: string;
  readonly to: string;
  readonly text: string | null;
  readonly next: string | null;
  readonly mode: number;
}

function planMove(root: string, from: string, to: string): MovePlan {
  const text = readText(join(root, from));

  return {
    from,
    to,
    text,
    next: text === null ? null : transformLayerPaths(text, { root, file: from, current: to }),
    mode: statSync(join(root, from)).mode,
  };
}

// true when another file sits at the move's destination; the file that an interrupted run wrote
// there, which holds what this move would write, is the move's own
function isTakenByOther(root: string, plan: MovePlan): boolean {
  if (!existsSync(join(root, plan.to))) {
    return false;
  }

  return plan.next === null
    ? !readFileSync(join(root, plan.to)).equals(readFileSync(join(root, plan.from)))
    : readText(join(root, plan.to)) !== plan.next;
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

// rewrites the paths in `file`, which stays where it is; true when its text changed
function updateFilePaths(root: string, file: string): boolean {
  const text = readText(join(root, file));

  if (text === null) {
    return false;
  }

  const next = transformLayerPaths(text, { root, file, current: file, exists: existsSync });

  if (next === text) {
    return false;
  }

  writeFileSync(join(root, file), next);

  return true;
}

// null for a file that is gone or binary (a NUL byte or invalid UTF-8), which holds no path to
// rewrite and keeps its bytes as they are
function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }

  const bytes = readFileSync(path);

  return bytes.includes(0) || !isUtf8(bytes) ? null : bytes.toString('utf8');
}
