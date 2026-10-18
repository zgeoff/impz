// Drops each `const { a, b } = ctx;` that no-pick-destructuring refuses and writes `ctx.a` at
// each use in its block, outside strings and comments. Run from the repo root:
// `bun scripts/dev/transform-context-members.ts <file>…`. A second run finds nothing to rewrite.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const DESTRUCTURE = /^\s*const \{ (?<names>[\w, ]+) \} = ctx;\n/gmv;

// what the character under the cursor is part of
type Mode = 'code' | 'line-comment' | 'block-comment' | 'quote' | 'template';

interface Scan {
  readonly source: string;
  readonly names: ReadonlySet<string>;
  readonly out: string[];

  // the open brackets, with `${` as `$`, whose close resumes the template
  readonly brackets: string[];
  readonly modes: Mode[];
  quote: string;
  index: number;

  // the `}` that closes the declaration's block was reached
  isDone: boolean;
}

// Each `const { a } = ctx;` goes, and `a` becomes `ctx.a` from there to the
// end of the block that holds the declaration, one declaration at a time.
export function transformContextMembers(source: string): string {
  let rewritten = source;

  for (;;) {
    const [match] = rewritten.matchAll(DESTRUCTURE);

    if (match === undefined) {
      return rewritten;
    }

    const names = new Set((match.groups?.['names'] ?? '').split(',').map((name) => name.trim()));

    const start = match.index;
    const rest = rewritten.slice(start + match[0].length);

    const scan: Scan = {
      source: rest,
      names,
      out: [],
      brackets: [],
      modes: ['code'],
      quote: '',
      index: 0,
      isDone: false,
    };

    while (!scan.isDone && scan.index < scan.source.length) {
      advance(scan);
    }

    rewritten = rewritten.slice(0, start) + scan.out.join('') + rest.slice(scan.index);
  }
}

function main(): void {
  const args = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true });

  for (const file of args.positionals) {
    const source = readFileSync(file, 'utf8');
    const rewritten = transformContextMembers(source);

    if (rewritten !== source) {
      writeFileSync(file, rewritten);

      console.log(`qualified ${file}`);
    }
  }
}

function advance(scan: Scan): void {
  const char = scan.source[scan.index] ?? '';
  const next = scan.source[scan.index + 1] ?? '';
  const mode = scan.modes.at(-1) ?? 'code';

  if (mode === 'line-comment' || mode === 'block-comment') {
    const isEnd = mode === 'line-comment' ? char === '\n' : char === '*' && next === '/';
    const count = mode === 'block-comment' && isEnd ? 2 : 1;

    if (isEnd) {
      scan.modes.pop();
    }

    advanceBy(scan, count);

    return;
  }

  if (mode === 'quote') {
    if (char === scan.quote) {
      scan.modes.pop();
    }

    const count = char === '\\' ? 2 : 1;

    advanceBy(scan, count);

    return;
  }

  if (mode === 'template') {
    const isOpen = char === '$' && next === '{';
    const count = char === '\\' || isOpen ? 2 : 1;

    if (char === '`') {
      scan.modes.pop();
    } else if (isOpen) {
      scan.modes.push('code');
      scan.brackets.push('$');
    }

    advanceBy(scan, count);

    return;
  }

  advanceCode(scan, char, next);
}

function advanceCode(scan: Scan, char: string, next: string): void {
  if (char === '/' && (next === '/' || next === '*')) {
    const comment = next === '/' ? 'line-comment' : 'block-comment';

    scan.modes.push(comment);

    advanceBy(scan, 2);

    return;
  }

  if (char === "'" || char === '"' || char === '`') {
    const literal = char === '`' ? 'template' : 'quote';

    scan.modes.push(literal);

    scan.quote = char;

    advanceBy(scan, 1);

    return;
  }

  if (')]}'.includes(char) && scan.brackets.length === 0) {
    scan.isDone = true;

    return;
  }

  if ('([{'.includes(char)) {
    scan.brackets.push(char);
  }

  if (')]}'.includes(char) && scan.brackets.pop() === '$') {
    scan.modes.pop();
  }

  const word = /^[A-Za-z_$][\w$]*/v.exec(scan.source.slice(scan.index))?.[0];

  if (word === undefined) {
    advanceBy(scan, 1);

    return;
  }

  const before = findSignificant(scan.source, scan.index - 1, -1);
  const isSpread = scan.source.slice(Math.max(0, scan.index - 3), scan.index) === '...';
  const after = findSignificant(scan.source, scan.index + word.length, 1);
  const isInObject = scan.brackets.at(-1) === '{' && '{,'.includes(before);

  // a name after a dot is another object's member, and one before a colon a key
  if (!scan.names.has(word) || (before === '.' && !isSpread) || (isInObject && after === ':')) {
    advanceBy(scan, word.length);

    return;
  }

  const isShorthand = isInObject && ',}'.includes(after);
  const qualified = isShorthand ? `${word}: ctx.${word}` : `ctx.${word}`;

  scan.out.push(qualified);

  scan.index += word.length;
}

// the nearest character that is not whitespace, walking by `step`
function findSignificant(source: string, from: number, step: number): string {
  let index = from;

  while (index >= 0 && index < source.length && /\s/v.test(source[index] ?? '')) {
    index += step;
  }

  return source[index] ?? '';
}

// copies `count` characters through unchanged
function advanceBy(scan: Scan, count: number): void {
  scan.out.push(scan.source.slice(scan.index, scan.index + count));

  scan.index += count;
}

if (import.meta.main) {
  main();
}
