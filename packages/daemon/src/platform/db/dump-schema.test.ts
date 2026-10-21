import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dumpSchema } from './dump-schema';

// After a migration, run `bun run render:db-schema` to regenerate the schema
// types.
test('it matches the committed schema.ts', async () => {
  const committed = readFileSync(join(import.meta.dir, 'schema.ts'), 'utf8');

  const rendered = await dumpSchema();

  expect(rendered).toBe(committed);
});

test('it renders the same file twice', async () => {
  const first = await dumpSchema();
  const second = await dumpSchema();

  expect(second).toBe(first);
});

test('it reads a text primary key as never null', async () => {
  const rendered = await dumpSchema();

  expect(rendered).toInclude(
    'export interface TokenSshKeys {\n  comment: string;\n  created_at: number;\n  fingerprint: string;\n  id: string;\n',
  );
});
