const RELEASE_REF =
  /ghcr\.io\/zgeoff\/imp-host:(?<tag>[\w.\-]+)|zgeoff\/impz\/v(?<source>[\w.\-]+)\//gv;

// A deploy file fetched from main runs main's code, so its URL carries no release.
const MAIN_URL = 'raw.githubusercontent.com/zgeoff/impz/main/deploy/';

// release-please's version pattern, less its pre-release and build parts.
const VERSION = /\d+\.\d+\.\d+/v;
const INLINE = 'x-release-please-version';
const BLOCK_START = 'x-release-please-start-version';
const BLOCK_END = 'x-release-please-end';

// bootstrap.sh and upgrade.sh turn this line of an earlier template into a comment.
const LEGACY_DEFINITION = /^readonly (?:LEGACY_IMAGE_LINE|legacy_image_line)=/v;

// A guide's prose may name another tag, such as latest; its code may not.
const FENCE = /^\s*```/v;

export interface ReleaseRefs {
  readonly problems: readonly string[];
  readonly defaults: number;
}

export function checkReleaseRefs(file: string, text: string, version: string): ReleaseRefs {
  const problems: string[] = [];
  let defaults = 0;
  let inBlock = false;
  let inFence = false;

  for (const [index, line] of text.split('\n').entries()) {
    const where = `${file}:${String(index + 1)}`;
    const fence = FENCE.test(line);

    inFence = fence ? !inFence : inFence;

    let marked = line.includes(INLINE);

    if (!marked && inBlock) {
      marked = true;
      inBlock = !line.includes(BLOCK_END);
    } else if (!marked && line.includes(BLOCK_START)) {
      inBlock = true;
    }

    const prose = file.endsWith('.md') && !fence && !inFence;
    const refs = [...line.matchAll(RELEASE_REF)];

    for (const match of refs) {
      const tag = match.groups?.['tag'] ?? match.groups?.['source'] ?? '';

      if (tag === version && marked) {
        defaults += 1;
      } else if (tag === version) {
        problems.push(`${where}: ${match[0]} is under no marker`);
      } else if (!prose && !(tag === 'latest' && LEGACY_DEFINITION.test(line))) {
        problems.push(`${where}: ${match[0]} is not this release (${version})`);
      }
    }

    if (line.includes(MAIN_URL)) {
      problems.push(`${where}: fetches from main, not this release`);
    }

    const first = marked ? VERSION.exec(line) : null;

    const inRef = refs.some(
      (match) =>
        first !== null && first.index >= match.index && first.index < match.index + match[0].length,
    );

    if (first !== null && !inRef) {
      problems.push(`${where}: the first X.Y.Z, ${first[0]}, is not a release reference`);
    }
  }

  return { problems, defaults };
}
