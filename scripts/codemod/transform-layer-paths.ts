import { dirname, join, relative, resolve, sep } from 'node:path';
import { LAYER_TABLE, planLayerPath } from './plan-layer-path';

// where a file sits: `file` before the move and `current` after it, both relative to `root`
export interface LayerPlace {
  readonly root: string;
  readonly file: string;
  readonly current: string;
}

// the text of the file at `place` with every path that names a moved daemon file rewritten
export function transformLayerPaths(text: string, place: LayerPlace): string {
  const relinked = CODE_FILE.test(place.current)
    ? RELATIVE_PATHS.reduce(
        (code, pattern) =>
          code.replaceAll(pattern, (match, head: string, quote: string, specifier: string) => {
            const relinkedSpecifier = planSpecifier(place, specifier);

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

  return place.current === 'knip.json' ? buildKnipConfig(repathed) : repathed;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u;

// the relative paths in code: an import, export, dynamic import, require or module mock, and a
// path from the file's own folder through `join(import.meta.dir, …)` or `new URL(…, import.meta.url)`
const RELATIVE_PATHS = [
  /(?<head>\b(?:from|import|require|mock\.module)\s*\(?\s*)(?<quote>['"])(?<specifier>\.{1,2}(?:\/[^'"\n]*)?)\k<quote>/gu,
  /(?<head>\bjoin\(\s*import\.meta\.dir\s*,\s*)(?<quote>['"])(?<specifier>[\w.-][^'"\n]*)\k<quote>/gu,
  /(?<head>\bnew URL\(\s*)(?<quote>['"])(?<specifier>[\w.-][^'"\n:]*)\k<quote>(?=\s*,\s*import\.meta\.url)/gu,
];

// the specifier that `specifier` becomes once the file sits at `current` and its target has moved
function planSpecifier(place: LayerPlace, specifier: string): string {
  const src = resolve(place.root, LAYER_TABLE.daemonSrc);
  const target = resolve(place.root, dirname(place.file), specifier);
  const isInSrc = target === src || target.startsWith(`${src}${sep}`);

  const movedTarget = isInSrc
    ? join(src, planLayerPath(relative(src, target).split(sep).join('/')))
    : target;

  if (movedTarget === target && place.file === place.current) {
    return specifier;
  }

  const path = relative(resolve(place.root, dirname(place.current)), movedTarget)
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

// a path under the daemon's src in any text: `@impz/daemon/src/db/imps`, a relative import from
// another package, a doc, a config file or a comment
const DAEMON_PATH = /(?<head>daemon\/src\/)(?<path>[\w.@-]+(?:\/[\w.@-]+)*)/gu;

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
