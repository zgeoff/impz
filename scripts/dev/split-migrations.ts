// Moves each entry of MIGRATIONS in packages/daemon/src/db/run-migrations.ts into a module of its own
// under db/migrations/, with the snapshot types it reads, and leaves the map naming them in order.
// Run from the repo root: `bun scripts/dev/split-migrations.ts`. A second run finds nothing to move.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_DIR = 'packages/daemon/src/db';
const SOURCE = join(DB_DIR, 'run-migrations.ts');
const MAP_START = 'export const MIGRATIONS: Record<string, Migration> = {\n';
const MAP_END = '\n};\n';

const ENTRY =
  /(?<comment>(?: {2}\/\/.*\n)*) {2}'(?<key>(?<number>\d{3})_(?<name>\w+))': \{\n(?<body>[\s\S]*?)\n {2}\},\n/gv;

const TYPE =
  /(?<comment>(?:\/\/.*\n)*)(?<keyword>type|interface) (?<name>\w+)(?: = [^\n]*;\n| \{\n[\s\S]*?\n\}\n)/gv;

interface Entry {
  readonly key: string;
  readonly constant: string;
  readonly file: string;
  readonly text: string;
}

// the imports a migration module may need, by the name each brings
const IMPORTS: readonly (readonly [string, string])[] = [
  ['sql', "import { sql } from 'kysely';"],
  ['Kysely', "import type { Kysely } from 'kysely';"],
  ['Migration', "import type { Migration } from 'kysely/migration';"],
  ['LEGACY_DISK_BYTES', "import { LEGACY_DISK_BYTES } from '../../process/legacy-disk-bytes';"],
  ['NoTables', "import type { NoTables } from './no-tables';"],
];

function main(): void {
  const source = readFileSync(SOURCE, 'utf8');
  const start = source.indexOf(MAP_START);

  if (start === -1) {
    throw new Error(`${SOURCE} has no MIGRATIONS map`);
  }

  const end = source.indexOf(MAP_END, start);
  const map = source.slice(start + MAP_START.length, end + 1);
  const head = source.slice(0, start);
  const types = [...head.matchAll(TYPE)];
  const entries = [...map.matchAll(ENTRY)].map((match) => buildEntry(match, types));

  if (entries.length === 0) {
    console.log('nothing to move');

    return;
  }

  mkdirSync(join(DB_DIR, 'migrations'), { recursive: true });

  for (const entry of entries) {
    writeFileSync(join(DB_DIR, 'migrations', entry.file), entry.text);
  }

  const noTables = types.find((match) => match.groups?.['name'] === 'NoTables')?.[0] ?? '';

  writeFileSync(
    join(DB_DIR, 'migrations', 'no-tables.ts'),
    noTables.replace(/^type /mv, 'export type '),
  );

  const imports = entries.map(
    (entry) =>
      `import { ${entry.constant} } from './migrations/${entry.file.replace(/\.ts$/v, '')}';`,
  );

  const lines = entries.map((entry) => `  '${entry.key}': ${entry.constant},`);

  const kept = head
    .replaceAll(TYPE, '')
    .replace("import { LEGACY_DISK_BYTES } from '../process/legacy-disk-bytes';\n", '');

  const firstImportEnd = kept.indexOf('\n\n');
  const rewritten = `${kept.slice(0, firstImportEnd)}\n${imports.join('\n')}${kept.slice(firstImportEnd)}${MAP_START}${lines.join('\n')}\n${source.slice(end + 1)}`;

  writeFileSync(SOURCE, rewritten.replaceAll(/\n{3,}/gv, '\n\n'));

  console.log(`moved ${String(entries.length)} migrations`);
}

function buildEntry(match: RegExpMatchArray, types: readonly RegExpMatchArray[]): Entry {
  const groups = match.groups ?? {};
  const key = groups['key'] ?? '';
  const name = groups['name'] ?? '';
  const constant = `MIGRATION_${groups['number'] ?? ''}_${name.toUpperCase()}`;
  const body = (groups['body'] ?? '').replaceAll(/^ {2}/gmv, '');
  const comment = (groups['comment'] ?? '').replaceAll(/^ {2}/gmv, '');
  const declaration = `${comment}export const ${constant}: Migration = {\n${body}\n};\n`;

  const snapshots = types.filter((type) => {
    const typeName = type.groups?.['name'] ?? '';

    return typeName !== 'NoTables' && new RegExp(`\\b${typeName}\\b`, 'v').test(body);
  });

  const text = [...snapshots.map((type) => type[0]), declaration].join('\n');

  const imports = IMPORTS.filter(([word]) => new RegExp(`\\b${word}\\b`, 'v').test(text)).map(
    ([, line]) => line,
  );

  return {
    key,
    constant,
    file: `migration-${groups['number'] ?? ''}-${name.replaceAll('_', '-')}.ts`,
    text: `${imports.join('\n')}\n\n${text}`,
  };
}

main();
