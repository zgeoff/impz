import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_FEATURES } from '@impz/api';
import { createImpClient } from '@impz/client';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import packageJson from '../../package.json' with { type: 'json' };
import { startTestImpd } from '../../testing/start-test-impd';
import { TEST_TOKEN } from '../../testing/test-token';
import { listApiCalls } from '../platform/db/api-audit';
import { MIGRATIONS } from '../platform/db/run-migrations';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ramReads: number[] = [];

  const harness = await startTestImpd(stack, {
    frozenClockMs: Date.UTC(2026, 0, 2, 3, 4, 5),
    boundaries: {
      imps: {
        readRamMib: (pid) => {
          ramReads.push(pid);

          return harness.fake.alive.has(pid) ? 300 : null;
        },
      },
    },
  });

  const sendToImpd = (request: Request) => harness.impd.api.app.handle(request);

  return {
    db: harness.db,
    dataDir: harness.dataDir,
    sendToImpd,
    ramReads,
    setClock: harness.setClock,
    createTestImage: harness.createTestImage,
    client: createImpClient({ url: 'http://impd.test', token: TEST_TOKEN, fetch: sendToImpd }),
  };
}

test('it answers the features with the impd version and every feature on', async () => {
  const ctx = await setupTest();
  const answer = await ctx.client.system.features();

  expect(answer).toStrictEqual({
    version: packageJson.version,
    features: SYSTEM_FEATURES,
  });
});

test('it answers the features without measuring an awake imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  ctx.ramReads.length = 0;

  await ctx.client.system.features();

  expect(ctx.ramReads).toStrictEqual([]);
});

test('it answers the features to a read-only token', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'watcher', scope: 'read' });

  const reader = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const answer = await reader.system.features();

  expect(answer.features).toStrictEqual(SYSTEM_FEATURES);
});

test('it answers a copy with its fields in the order a restore script reads them', async () => {
  const ctx = await setupTest();
  const copy = await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  expect(Object.keys(copy)).toStrictEqual([
    'path',
    'sizeBytes',
    'lastMigration',
    'impVersion',
    'createdAt',
    'integrity',
  ]);
});

test('it answers a copy with its path, size, schema version, impd version and time', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 4, 6, 7, 8, 9));

  const copy = await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const path = join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite');
  const lastMigration = Object.keys(MIGRATIONS).toSorted().at(-1);

  invariant(lastMigration !== undefined);

  expect(copy).toStrictEqual({
    path,
    sizeBytes: statSync(path).size,
    lastMigration,
    impVersion: packageJson.version,
    createdAt: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
    integrity: 'ok',
  });
});

test('it writes the copy owner-only in an owner-only directory', async () => {
  const ctx = await setupTest();

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  expect(statSync(join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite')).mode & 0o777).toBe(
    0o600,
  );

  expect(statSync(join(ctx.dataDir, 'db-copies')).mode & 0o777).toBe(0o700);
});

test('it copies the rows the database holds', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const opened = new Database(join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite'), {
    readonly: true,
  });

  onTestFinished(() => {
    opened.close();
  });

  expect(opened.query('SELECT name FROM imps').all()).toStrictEqual([{ name: 'dev' }]);
});

test('it records the copy in the API audit log', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 4, 6, 7, 8, 9));

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const audit = await waitFor(async () => {
    const calls = await listApiCalls(ctx.db, null, 100, null);

    const copies = calls.filter((call) => call.procedure === 'system.copyDatabase');

    expect(copies).toHaveLength(1);

    return copies;
  });

  expect(audit).toStrictEqual([
    {
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      procedure: 'system.copyDatabase',
      actor: 'token',
      actorName: 'root',
      outcome: 'ok',
      durationMs: 0,
    },
  ]);
});

test('it names a copy without a name for the time it was taken', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 4, 6, 7, 8, 9));

  const copy = await ctx.client.system.copyDatabase({});

  expect(copy.path).toBe(join(ctx.dataDir, 'db-copies', 'imp-20260506-070809.sqlite'));
});

test('it refuses a name a copy already has with a conflict', async () => {
  const ctx = await setupTest();

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  expect(ctx.client.system.copyDatabase({ name: 'before-upgrade' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test.each([['../../etc/x'], ['/tmp/x']])('it refuses %s as a copy name', async (name) => {
  const ctx = await setupTest();

  expect(ctx.client.system.copyDatabase({ name })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a copy to a manage token limited to some imps', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'scoped', scope: 'manage', imps: ['dev*'] });

  const scoped = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(scoped.system.copyDatabase({ name: 'scoped' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it lets a host-wide manage token copy', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'host-wide', scope: 'manage' });

  const hostWide = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const copy = await hostWide.system.copyDatabase({ name: 'host-wide' });

  expect(copy.path).toBe(join(ctx.dataDir, 'db-copies', 'host-wide.sqlite'));
});
