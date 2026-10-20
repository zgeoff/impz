import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLayerMoves } from './apply-layer-moves';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'apply-layer-moves-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root };
}

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
  ).toStrictEqual({ moved: [], rewritten: [], unplaced: [], collisions: [] });
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

test('it moves a file that is not valid UTF-8 with its bytes unchanged', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/db/fixture.bin'),
    new Uint8Array([0x66, 0xff, 0x2e, 0x2e, 0x2f]),
  );

  applyLayerMoves(ctx.root, ['packages/daemon/src/db/fixture.bin']);

  expect([
    ...readFileSync(join(ctx.root, 'packages/daemon/src/platform/db/fixture.bin')),
  ]).toStrictEqual([0x66, 0xff, 0x2e, 0x2e, 0x2f]);
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
    collisions: [],
  });
});

test('it relinks an import that a merge carried into a placed file', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/imps/imps/imp-service.ts'),
    "import { readQuery } from '../db/new-query';\n",
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/db/new-query.ts'),
    'export const readQuery = 1;\n',
  );

  applyLayerMoves(ctx.root, [
    'packages/daemon/src/imps/imps/imp-service.ts',
    'packages/daemon/src/db/new-query.ts',
  ]);

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/imps/imps/imp-service.ts'), 'utf8')).toBe(
    "import { readQuery } from '../../platform/db/new-query';\n",
  );
});

test('it carries on from a run that stopped after it wrote a moved file', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/imps/imp-service.ts'),
    "import { readImp } from '../db/imps';\n",
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/imps/imps/imp-service.ts'),
    "import { readImp } from '../../platform/db/imps';\n",
  );

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const readImp = 1;\n');

  const report = applyLayerMoves(ctx.root, [
    'packages/daemon/src/imps/imp-service.ts',
    'packages/daemon/src/imps/imps/imp-service.ts',
    'packages/daemon/src/db/imps.ts',
  ]);

  expect(report.collisions).toStrictEqual([]);
  expect(existsSync(join(ctx.root, 'packages/daemon/src/imps/imp-service.ts'))).toBeFalse();

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/imps/imps/imp-service.ts'), 'utf8')).toBe(
    "import { readImp } from '../../platform/db/imps';\n",
  );

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/platform/db/imps.ts'), 'utf8')).toBe(
    'export const readImp = 1;\n',
  );
});

test('it moves no file when a destination already holds one', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const old = 1;\n');

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/platform/db/imps.ts'),
    'export const placed = 1;\n',
  );

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/net/addressing.ts'),
    'export const addressing = 1;\n',
  );

  const report = applyLayerMoves(ctx.root, [
    'packages/daemon/src/db/imps.ts',
    'packages/daemon/src/platform/db/imps.ts',
    'packages/daemon/src/net/addressing.ts',
  ]);

  expect(report).toStrictEqual({
    moved: [],
    rewritten: [],
    unplaced: [],
    collisions: [['packages/daemon/src/db/imps.ts', 'packages/daemon/src/platform/db/imps.ts']],
  });

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'utf8')).toBe(
    'export const old = 1;\n',
  );

  expect(readFileSync(join(ctx.root, 'packages/daemon/src/platform/db/imps.ts'), 'utf8')).toBe(
    'export const placed = 1;\n',
  );

  expect(existsSync(join(ctx.root, 'packages/daemon/src/net/addressing.ts'))).toBeTrue();
});
