// Moves impd's folders under one folder per layer and rewrites every path that names them. A run
// on its own output changes nothing, so a branch that conflicts with the move merges main and runs
// it again. Usage (from the repo root): bun scripts/codemod/nest-daemon-layers.ts
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

const DAEMON_SRC = 'packages/daemon/src';

// the layers from the bottom up: a layer imports only the layers below it
const LAYERS = [
  'platform',
  'host-net',
  'vm',
  'imps',
  'network',
  'identity',
  'imp-ops',
  'surface',
] as const;

// each old folder or file stem under src, and the path it moves to. A file stem moves the file's
// test too, and the longest match wins, so `ssh/ssh-gateway` moves out of the `ssh` folder.
const LAYER_MOVES: Readonly<Record<string, string>> = {
  // platform: the helpers every layer uses
  audit: 'platform/audit',
  db: 'platform/db',
  events: 'platform/events',
  process: 'platform/process',
  telemetry: 'platform/telemetry',
  'merge-signals': 'platform/process/merge-signals',
  'read-error-message': 'platform/process/read-error-message',

  // host-net: the host's addressing, TAP devices and routes
  net: 'host-net/net',

  // vm: one microVM and its guest agent
  'agent-client': 'vm/agent-client',
  'checkpoints/consistent-disk': 'vm/checkpoints/consistent-disk',
  governor: 'vm/governor',
  memory: 'vm/memory',
  sleep: 'vm/sleep',
  storage: 'vm/storage',
  templates: 'vm/templates',
  vmm: 'vm/vmm',
  'watchdog/agent-watchdog': 'vm/watchdog/agent-watchdog',

  // imps: an imp and what runs inside it
  'docker-proxy': 'imps/docker-proxy',
  exec: 'imps/exec',
  files: 'imps/files',
  images: 'imps/images',
  imps: 'imps/imps',
  reverse: 'imps/reverse',
  services: 'imps/services',
  'session-logs': 'imps/session-logs',
  sessions: 'imps/sessions',
  ssh: 'imps/ssh',
  tunnel: 'imps/tunnel',

  // network: the imps' networks, egress, ingress and the secret broker
  broker: 'network/broker',
  egress: 'network/egress',
  https: 'network/https',
  networks: 'network/networks',
  proxy: 'network/proxy',
  'tailnet-names': 'network/tailnet-names',

  // identity: who calls impd
  auth: 'identity/auth',
  oauth: 'identity/oauth',
  token: 'identity/token',

  // imp-ops: the operations that drive whole imps
  backup: 'imp-ops/backup',
  checkpoints: 'imp-ops/checkpoints',
  idle: 'imp-ops/idle',
  moves: 'imp-ops/moves',
  watchdog: 'imp-ops/watchdog',

  // surface: the API, the gateways and the routes that callers reach
  'api-errors': 'surface/api-errors',
  'api-listen-options': 'surface/api-listen-options',
  'auth/session-routes': 'surface/auth/session-routes',
  'build-app': 'surface/build-app',
  'build-audit-routes': 'surface/build-audit-routes',
  'build-dashboard-routes': 'surface/build-dashboard-routes',
  'build-grant-routes': 'surface/build-grant-routes',
  'build-image-routes': 'surface/build-image-routes',
  'build-implementer': 'surface/build-implementer',
  'build-network-routes': 'surface/build-network-routes',
  'build-oauth-routes': 'surface/build-oauth-routes',
  'build-router': 'surface/build-router',
  'build-secret-routes': 'surface/build-secret-routes',
  'build-system-routes': 'surface/build-system-routes',
  'build-token-routes': 'surface/build-token-routes',
  dashboard: 'surface/dashboard',
  'exec/exec-grant': 'surface/exec/exec-grant',
  'exec/exec-tickets': 'surface/exec/exec-tickets',
  'images/build-context-route': 'surface/images/build-context-route',
  'is-public-cross-origin': 'surface/is-public-cross-origin',
  mcp: 'surface/mcp',
  'oauth/public-listener': 'surface/oauth/public-listener',
  'read-buffered-amount': 'surface/read-buffered-amount',
  'require-named-imp': 'surface/require-named-imp',
  'ssh/host-key': 'surface/ssh/host-key',
  'ssh/login-keys': 'surface/ssh/login-keys',
  'ssh/ssh-gateway': 'surface/ssh/ssh-gateway',
  'ssh/start-ssh': 'surface/ssh/start-ssh',
  'to-api-image': 'surface/to-api-image',
  'with-retry-after': 'surface/with-retry-after',
};

// the composition root's files, which import every layer and stay at the top of src
const ROOT_STEMS = [
  'build-impd-app',
  'build-impd-services',
  'build-impd-storage',
  'build-tailnet-access',
  'config',
  'create-impd',
  'create-impd-firewall',
  'create-impd-imps',
  'create-impd-moves',
  'impd-deps',
  'impd-startup-steps',
  'index',
  'load-impd-access',
  'main',
  'render-network-env',
  'shell-script',
  'start-impd-listeners',
  'start-impd-tickers',
  'stop-impd',
] as const;

// a moved path's first two segments mark a path as placed: `imps` is a layer and an old folder
// both, so `imps/imp-service.ts` moves and `imps/imps/imp-service.ts` stays
const PLACED_PREFIXES = new Set(
  Object.values(LAYER_MOVES).map((target) => target.split('/').slice(0, 2).join('/')),
);

const MOVE_KEYS = Object.keys(LAYER_MOVES).toSorted((a, b) => b.length - a.length);

// the path under src that `path` moves to, or `path` itself when it is already placed or stays
export function planLayerPath(path: string): string {
  if (isPlaced(path)) {
    return path;
  }

  const key = MOVE_KEYS.find(
    (candidate) =>
      path === candidate || path.startsWith(`${candidate}/`) || path.startsWith(`${candidate}.`),
  );

  return key === undefined ? path : `${LAYER_MOVES[key]}${path.slice(key.length)}`;
}

// every path is relative to the repository root
export interface LayerReport {
  readonly moved: readonly (readonly [from: string, to: string])[];
  readonly rewritten: readonly string[];

  // the files under src that no move and no root stem covers, to add to the tables above
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

function isPlaced(path: string): boolean {
  return PLACED_PREFIXES.has(path.split('/').slice(0, 2).join('/'));
}

function planRepoPath(file: string): string {
  if (!file.startsWith(`${DAEMON_SRC}/`)) {
    return file;
  }

  return `${DAEMON_SRC}/${planLayerPath(file.slice(DAEMON_SRC.length + 1))}`;
}

function isCovered(file: string): boolean {
  const path = file.slice(DAEMON_SRC.length + 1);
  const isRoot = !path.includes('/') && ROOT_STEMS.some((stem) => path.startsWith(`${stem}.`));

  return isRoot || (LAYERS as readonly string[]).includes(path.split('/')[0] ?? '');
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

// the release notes keep the paths that each release had, and the codemod keeps its own fixtures
const SKIPPED_FILES = /(?:^|\/)CHANGELOG\.md$|^bun\.lock$|^scripts\/codemod\//u;

// the files that the pre-commit hook formats with oxfmt
const FORMATTED_FILE = /\.(?:[cm]?[jt]sx?|jsonc?|md|css|ya?ml|html)$/u;

function main(): void {
  const root = process.cwd();

  const listed = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root },
  );

  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }

  const files = [...new Set(listed.stdout.toString().split('\0'))].filter(
    (file) => file !== '' && !SKIPPED_FILES.test(file) && existsSync(join(root, file)),
  );

  const report = applyLayerMoves(root, files);

  console.log(`moved ${report.moved.length} files, rewrote ${report.rewritten.length} files`);

  // a longer path can push a line past the width, so the rewritten files are formatted again
  const formattable = report.rewritten.filter((file) => FORMATTED_FILE.test(file));

  if (formattable.length > 0) {
    Bun.spawnSync(['node_modules/.bin/oxfmt', '--no-error-on-unmatched-pattern', ...formattable], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    });
  }

  for (const file of report.unplaced) {
    console.error(`unplaced: ${file} (add it to LAYER_MOVES or ROOT_STEMS)`);
  }

  if (report.unplaced.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
