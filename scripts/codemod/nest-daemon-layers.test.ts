import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLayerMoves, planLayerPath } from './nest-daemon-layers';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'nest-daemon-layers-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root };
}

test.each([
  ['a folder', 'db/imps.ts', 'platform/db/imps.ts'],
  ['a folder without an extension', 'db/imps', 'platform/db/imps'],
  ['a test beside its module', 'net/addressing.test.ts', 'host-net/net/addressing.test.ts'],
  ['a file that leaves its folder', 'ssh/ssh-gateway.ts', 'surface/ssh/ssh-gateway.ts'],
  ['a sibling of a file that leaves', 'ssh/channel-io.ts', 'imps/ssh/channel-io.ts'],
  ['a file of the old imps folder', 'imps/imp-service.ts', 'imps/imps/imp-service.ts'],
  ['a placed file of the imps layer', 'imps/imps/imp-service.ts', 'imps/imps/imp-service.ts'],
  ['a placed file', 'platform/db/imps.ts', 'platform/db/imps.ts'],
  ['a file at the top of src', 'build-app.ts', 'surface/build-app.ts'],
  ['a root file', 'main.ts', 'main.ts'],
  ['a name that only starts like a stem', 'token-store.ts', 'token-store.ts'],
])('it moves %s from %s to %s', (_label, path, expected) => {
  expect(planLayerPath(path)).toBe(expected);
});

test('it moves the files and rewrites the paths that name them', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/imps/imp-service.ts'),
    "import { readImp } from '../db/imps';\n",
  );

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const readImp = 1;\n');

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/ssh/ssh-gateway.ts'),
    [
      "import { impService } from '../imps/imp-service';",
      "import { channel } from './channel-io';",
      "import { start } from '..';",
      '',
    ].join('\n'),
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/ssh/channel-io.ts'),
    'export const channel = 1;\n',
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/ssh/channel-io.test.ts'),
    [
      "const script = join(import.meta.dir, '../../testing/run-stub.ts');",
      "const sibling = new URL('ssh-gateway.ts', import.meta.url);",
      '',
    ].join('\n'),
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/main.ts'),
    "import { start } from './ssh/ssh-gateway';\n",
  );

  await Bun.write(
    join(ctx.root, 'packages/cli/src/run.test.ts'),
    [
      "import { readImp } from '@impz/daemon/src/db/imps';",
      "import { impService } from '../../daemon/src/imps/imp-service';",
      '',
    ].join('\n'),
  );

  await Bun.write(
    join(ctx.root, 'notes/guide.md'),
    'See `packages/daemon/src/net/addressing.ts:12` and `src/net/x`.\n',
  );

  applyLayerMoves(ctx.root, [
    'packages/daemon/src/imps/imp-service.ts',
    'packages/daemon/src/db/imps.ts',
    'packages/daemon/src/ssh/ssh-gateway.ts',
    'packages/daemon/src/ssh/channel-io.ts',
    'packages/daemon/src/ssh/channel-io.test.ts',
    'packages/daemon/src/main.ts',
    'packages/cli/src/run.test.ts',
    'notes/guide.md',
  ]);

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/imps/imps/imp-service.ts'), 'utf8')).toBe(
    "import { readImp } from '../../platform/db/imps';\n",
  );

  expect(
    readFileSync(join(ctx.root, 'packages/daemon/src/surface/ssh/ssh-gateway.ts'), 'utf8'),
  ).toBe(
    [
      "import { impService } from '../../imps/imps/imp-service';",
      "import { channel } from '../../imps/ssh/channel-io';",
      "import { start } from '../..';",
      '',
    ].join('\n'),
  );

  expect(
    readFileSync(join(ctx.root, 'packages/daemon/src/imps/ssh/channel-io.test.ts'), 'utf8'),
  ).toBe(
    [
      "const script = join(import.meta.dir, '../../../testing/run-stub.ts');",
      "const sibling = new URL('../../surface/ssh/ssh-gateway.ts', import.meta.url);",
      '',
    ].join('\n'),
  );

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/main.ts'), 'utf8')).toBe(
    "import { start } from './surface/ssh/ssh-gateway';\n",
  );

  expect(readFileSync(join(ctx.root, 'packages/cli/src/run.test.ts'), 'utf8')).toBe(
    [
      "import { readImp } from '@impz/daemon/src/platform/db/imps';",
      "import { impService } from '../../daemon/src/imps/imps/imp-service';",
      '',
    ].join('\n'),
  );

  expect(readFileSync(join(ctx.root, 'notes/guide.md'), 'utf8')).toBe(
    'See `packages/daemon/src/host-net/net/addressing.ts:12` and `src/net/x`.\n',
  );
});

test("it rewrites the src paths of knip's daemon workspace only", async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'knip.json'),
    [
      '{',
      '  "workspaces": {',
      '    "packages/daemon": {',
      '      "entry": ["src/docker-proxy/main.ts", "src/**/*.pebble.ts"],',
      '      "ignoreIssues": { "src/db/schema.ts": ["types"] }',
      '    },',
      '    "packages/cli": { "entry": ["src/db/main.ts"] }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  applyLayerMoves(ctx.root, ['knip.json']);

  expect(readFileSync(join(ctx.root, 'knip.json'), 'utf8')).toBe(
    [
      '{',
      '  "workspaces": {',
      '    "packages/daemon": {',
      '      "entry": ["src/imps/docker-proxy/main.ts", "src/**/*.pebble.ts"],',
      '      "ignoreIssues": { "src/platform/db/schema.ts": ["types"] }',
      '    },',
      '    "packages/cli": { "entry": ["src/db/main.ts"] }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
});

test('it changes nothing on a second run', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/imps/imp-service.ts'),
    "import { readImp } from '../db/imps';\n",
  );

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const readImp = 1;\n');

  await Bun.write(
    join(ctx.root, 'notes/guide.md'),
    'See `packages/daemon/src/imps/imp-service.ts`.\n',
  );

  applyLayerMoves(ctx.root, [
    'packages/daemon/src/imps/imp-service.ts',
    'packages/daemon/src/db/imps.ts',
    'notes/guide.md',
  ]);

  expect(
    applyLayerMoves(ctx.root, [
      'packages/daemon/src/imps/imps/imp-service.ts',
      'packages/daemon/src/platform/db/imps.ts',
      'notes/guide.md',
    ]),
  ).toStrictEqual({ moved: [], rewritten: [], unplaced: [] });
});

test('it moves a file that a branch adds at an old path after the move', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/platform/db/imps.ts'),
    'export const readImp = 1;\n',
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/imps/imp-limits.ts'),
    "import { readImp } from '../db/imps';\n",
  );

  const report = applyLayerMoves(ctx.root, [
    'packages/daemon/src/platform/db/imps.ts',
    'packages/daemon/src/imps/imp-limits.ts',
  ]);

  expect(report.moved).toStrictEqual([
    ['packages/daemon/src/imps/imp-limits.ts', 'packages/daemon/src/imps/imps/imp-limits.ts'],
  ]);

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/imps/imps/imp-limits.ts'), 'utf8')).toBe(
    "import { readImp } from '../../platform/db/imps';\n",
  );
});

test('it reports a file under src that no move or root stem covers', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/quotas/quota.ts'),
    'export const quota = 1;\n',
  );

  expect(applyLayerMoves(ctx.root, ['packages/daemon/src/quotas/quota.ts'])).toStrictEqual({
    moved: [],
    rewritten: [],
    unplaced: ['packages/daemon/src/quotas/quota.ts'],
  });
});
