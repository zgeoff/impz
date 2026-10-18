// oxlint-disable zgeoff/test-beside-module -- tests .oxlintrc.json, a config with no module to sit beside
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod';

// Each test lints one fixture in a temp tree laid out like packages/, under a
// config that extends the real one. The rule judges a relative import only when
// it resolves, so a test that imports a file writes that file too.

const DiagnosticSchema = z.object({ code: z.string(), message: z.string() });
const DiagnosticsSchema = z.object({ diagnostics: z.array(DiagnosticSchema) });

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-import-rules-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the rules under test: the real config, applied to the temp tree
  writeFileSync(
    join(dir, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(import.meta.dir, '.oxlintrc.json')] }),
  );

  return { dir, oxlint: join(import.meta.dir, 'node_modules/.bin/oxlint') };
}

test.each([
  ['kysely', 'packages/daemon/src/imps/fixture.ts', 'kysely'],
  ['kysely', 'packages/cli/src/fixture.test.ts', 'kysely'],
  ['kysely', 'packages/test-utils/src/fixture.ts', 'kysely/helpers/sqlite'],
  ['runtime-neutral', 'packages/shared/src/fixture.ts', 'node:path'],
  ['runtime-neutral', 'packages/api/src/fixture.ts', 'node:path'],
  ['runtime-neutral', 'packages/client/src/fixture.ts', 'node:path'],
  ['test-support', 'packages/daemon/src/imps/fixture.ts', '@impz/test-utils/wait-for'],

  // the client may import @impz/api, but not the api's test helpers
  ['test-support', 'packages/client/src/fixture.ts', '@impz/api/test-utils/build-mock-image'],
  ['package-order', 'packages/shared/src/fixture.ts', '@impz/api'],
  ['package-order', 'packages/local-tar/src/fixture.ts', '@impz/api'],
  ['package-order', 'packages/test-utils/src/fixture.ts', '@impz/api'],
  ['package-order', 'packages/api/src/fixture.ts', '@impz/client'],
  ['package-order', 'packages/client/src/fixture.ts', '@impz/mcp'],
  ['package-order', 'packages/mcp/src/fixture.ts', '@impz/daemon/src/config'],
  ['package-order', 'packages/cli/src/fixture.ts', '@impz/daemon/src/create-impd'],
  ['package-order', 'packages/daemon/src/fixture.ts', '@impz/cli'],
  ['package-order', 'packages/dashboard/src/fixture.ts', '@impz/daemon/src/auth/authenticate'],
])('it refuses a %s import in %s of %s', (rule, path, source) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { value } from '${source}';\n\nexport const used = value;\n`);

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const rules = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'zgeoff(import-zones)')
    .map((diagnostic) => diagnostic.message.split(':')[0]);

  expect([...new Set(rules)]).toStrictEqual([rule]);
});

test.each([
  [
    'test-support',
    'packages/daemon/src/imps/fixture.ts',
    '../test-utils/build-stub-vmm',
    'packages/daemon/src/test-utils/build-stub-vmm.ts',
  ],
  [
    'test-support',
    'packages/cli/src/fixture.ts',
    './test-utils/start-cli',
    'packages/cli/src/test-utils/start-cli.ts',
  ],
  [
    'test-support',
    'packages/dashboard/src/fixture.ts',
    './mocks/db/imp-collection',
    'packages/dashboard/src/mocks/db/imp-collection.ts',
  ],
  [
    'test-support',
    'packages/client/src/fixture.ts',
    '../smoke/run-stub-impd',
    'packages/client/smoke/run-stub-impd.ts',
  ],
  [
    'package-by-name',
    'packages/cli/src/fixture.ts',
    '../../daemon/src/create-impd',
    'packages/daemon/src/create-impd.ts',
  ],
  [
    'package-by-name',
    'packages/test-utils/src/fixture.ts',
    '../../daemon/src/create-impd',
    'packages/daemon/src/create-impd.ts',
  ],
])('it refuses a %s import in %s of %s', (rule, path, source, target) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { value } from '${source}';\n\nexport const used = value;\n`);
  mkdirSync(dirname(join(ctx.dir, target)), { recursive: true });
  writeFileSync(join(ctx.dir, target), 'export const value = 1;\n');

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const rules = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'zgeoff(import-zones)')
    .map((diagnostic) => diagnostic.message.split(':')[0]);

  expect([...new Set(rules)]).toStrictEqual([rule]);
});

test.each([
  ['the daemon database folder', 'packages/daemon/src/db/fixture.ts', 'kysely'],
  ['a database test', 'packages/daemon/src/db/fixture.test.ts', 'kysely'],
  ["the daemon's test helpers", 'packages/daemon/src/test-utils/fixture.ts', 'kysely'],
  ['a test of a runtime-neutral package', 'packages/api/src/fixture.test.ts', 'node:path'],
  ['a package above the client', 'packages/local-tar/src/fixture.ts', 'node:path'],
  ['a test', 'packages/daemon/src/imps/fixture.test.ts', '@impz/test-utils/wait-for'],
  ['a test helper', 'packages/cli/src/test-utils/fixture.ts', '@impz/test-utils/wait-for'],
  ["the dashboard's mock impd", 'packages/dashboard/src/mocks/fixture.ts', '@impz/test-utils'],
  ["the client's smoke", 'packages/client/smoke/fixture.ts', '@impz/test-utils/wait-for'],
  ['local-tar', 'packages/local-tar/src/fixture.ts', '@impz/shared/format-bytes'],
  ['api', 'packages/api/src/fixture.ts', '@impz/shared'],
  ['the client', 'packages/client/src/fixture.ts', '@impz/api'],
  ['mcp', 'packages/mcp/src/fixture.ts', '@impz/local-tar'],
  ['mcp', 'packages/mcp/src/fixture.ts', '@impz/client'],
  ['the cli', 'packages/cli/src/fixture.ts', '@impz/mcp'],
  ['the daemon', 'packages/daemon/src/fixture.ts', '@impz/client'],
  ['the dashboard', 'packages/dashboard/src/fixture.ts', '@impz/api'],
])('it allows %s in %s to import %s', (_label, path, source) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { value } from '${source}';\n\nexport const used = value;\n`);

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'zgeoff(import-zones)')
    .map((diagnostic) => diagnostic.message);

  expect(messages).toStrictEqual([]);
});

test('it counts a type-only import against the package order', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages/api/src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import type { Imp } from '@impz/client';\n\nexport type Used = Imp;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'zgeoff(import-zones)')
    .map((diagnostic) => diagnostic.message);

  expect(messages).toStrictEqual([
    'package-order: @impz/client is allowed only in above-client, tests — only @impz/mcp and the apps import @impz/local-tar, the client and @impz/mcp',
  ]);
});

test('it counts a type-only re-export against the package order', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages/client/src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export type { ImpDeps } from '@impz/daemon/src/create-impd';\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'zgeoff(import-zones)')
    .map((diagnostic) => diagnostic.message);

  expect(messages).toStrictEqual([
    'package-order: @impz/daemon/src/create-impd is allowed only in tests — an app imports no other app',
  ]);
});
