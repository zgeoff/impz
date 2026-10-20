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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { LAYER_TABLE, planLayerPath } from './plan-layer-path';

const DAEMON_SRC = LAYER_TABLE.daemonSrc;

// every path is relative to the repository root
export interface LayerReport {
  readonly moved: readonly (readonly [from: string, to: string])[];
  readonly rewritten: readonly string[];

  // the files under src that no move and no root stem covers, to add to the layer table
  readonly unplaced: readonly string[];
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

// the relative paths in code: an import, export, dynamic import, require or module mock, and a
// path from the file's own folder through `join(import.meta.dir, …)` or `new URL(…, import.meta.url)`
const RELATIVE_PATHS = [
  /(?<head>\b(?:from|import|require|mock\.module)\s*\(?\s*)(?<quote>['"])(?<specifier>\.{1,2}(?:\/[^'"\n]*)?)\k<quote>/gu,
  /(?<head>\bjoin\(\s*import\.meta\.dir\s*,\s*)(?<quote>['"])(?<specifier>[\w.-][^'"\n]*)\k<quote>/gu,
  /(?<head>\bnew URL\(\s*)(?<quote>['"])(?<specifier>[\w.-][^'"\n:]*)\k<quote>(?=\s*,\s*import\.meta\.url)/gu,
];

// a path under the daemon's src in any text: `@impz/daemon/src/db/imps`, a relative import from
// another package, a doc, a config file or a comment
const DAEMON_PATH = /(?<head>daemon\/src\/)(?<path>[\w.@-]+(?:\/[\w.@-]+)*)/gu;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u;

// rewrites the paths in `file`, which now sits at `current`; true when its text changed
function updateFilePaths(root: string, file: string, current: string): boolean {
  const text = readText(join(root, current));

  if (text === null) {
    return false;
  }

  const relinked = CODE_FILE.test(current)
    ? RELATIVE_PATHS.reduce(
        (code, pattern) =>
          code.replaceAll(pattern, (match, head: string, quote: string, specifier: string) => {
            const relinkedSpecifier = planSpecifier(root, file, current, specifier);

            return relinkedSpecifier === specifier
              ? match
              : `${head}${quote}${relinkedSpecifier}${quote}`;
          }),
        text,
      )
    : text;

  const repathed = relinked.replaceAll(
    DAEMON_PATH,
    (_match, head: string, path: string) => `${head}${planLayerPath(path)}`,
  );

  const next = current === 'knip.json' ? buildKnipConfig(repathed) : repathed;

  if (next === text) {
    return false;
  }

  writeFileSync(join(root, current), next);

  return true;
}

// knip's daemon workspace names its files from the package root, as `src/docker-proxy/main.ts`
const KNIP_DAEMON_WORKSPACE = /"packages\/daemon": \{[^}]*(?:\{[^}]*\}[^}]*)*\}/u;
const KNIP_SRC_PATH = /(?<head>"src\/)(?<path>[\w.@-]+(?:\/[\w.@-]+)*)/gu;

function buildKnipConfig(text: string): string {
  return text.replace(KNIP_DAEMON_WORKSPACE, (workspace) =>
    workspace.replaceAll(
      KNIP_SRC_PATH,
      (_match, head: string, path: string) => `${head}${planLayerPath(path)}`,
    ),
  );
}

// the specifier that `specifier` becomes once `file` sits at `current` and its target has moved
function planSpecifier(root: string, file: string, current: string, specifier: string): string {
  const src = resolve(root, DAEMON_SRC);
  const target = resolve(root, dirname(file), specifier);
  const isInSrc = target === src || target.startsWith(`${src}${sep}`);

  const movedTarget = isInSrc
    ? join(src, planLayerPath(relative(src, target).split(sep).join('/')))
    : target;

  if (movedTarget === target && file === current) {
    return specifier;
  }

  const path = relative(resolve(root, dirname(current)), movedTarget)
    .split(sep)
    .join('/');

  const trailing = specifier.endsWith('/') && !path.endsWith('/') ? '/' : '';

  if (path === '') {
    return `.${trailing}`;
  }

  // a path from the file's own folder keeps its form: `./x` stays `./x`, and `x` stays `x`
  const prefix = path.startsWith('.') || !specifier.startsWith('.') ? '' : './';

  return `${prefix}${path}${trailing}`;
}

// null for a file that is gone or binary (a NUL byte), which holds no path to rewrite
function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }

  const bytes = readFileSync(path);

  return bytes.includes(0) ? null : bytes.toString('utf8');
}
