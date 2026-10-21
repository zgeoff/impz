import { expect, onTestFinished, test } from 'bun:test';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { startTestImpd } from '../../../testing/start-test-impd';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createImage } from './images';
import { readImpByName } from './imps';
import { listGrantNames, listGrantedRules } from './secrets';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  return harness;
}

test('it makes exactly one of two clashing grants made at once, and refuses the other', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  const results = await Promise.allSettled([
    ctx.client.grants.add({ name: 'dev', secret: 'gh' }),
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
  ]);

  const dev = await readImpByName(ctx.db, 'dev');

  invariant(dev);

  const granted = await listGrantedRules(ctx.db, dev.id);

  const hosts = granted.map((each) => each.rule.host);

  const left = await ctx.client.grants.list({ name: 'dev' });

  expect(results).toIncludeSameMembers([
    { status: 'fulfilled', value: {} },
    { status: 'rejected', reason: expect.toContainEntry(['code', 'CONFLICT']) },
  ]);

  expect(left).toStrictEqual([expect.toBeOneOf(['gh', 'gh-api'])]);
  expect(new Set(hosts).size).toBe(hosts.length);
});

test('it ends a grant and a revoke made at once as one of the two orders', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  const results = await Promise.allSettled([
    ctx.client.grants.add({ name: 'dev', secret: 'gh' }),
    ctx.client.grants.delete({ name: 'dev', secret: 'gh' }),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });

  // one outcome of one order: grant then revoke leaves nothing; revoke first
  // finds no grant and the grant stays, so the results and the grants left
  // are checked together
  const outcome: unknown = { results, left };

  expect(outcome).toBeOneOf([
    {
      results: [
        { status: 'fulfilled', value: {} },
        { status: 'fulfilled', value: {} },
      ],
      left: [],
    },
    {
      results: [
        { status: 'fulfilled', value: {} },
        { status: 'rejected', reason: expect.toContainEntry(['code', 'NOT_FOUND']) },
      ],
      left: ['gh'],
    },
  ]);
});

test('it skips the clashing copy when a fork gets a grant while its source’s are copied', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const results = await Promise.allSettled([
    ctx.impd.broker.createForkGrants(dev, copy, null),
    ctx.client.grants.add({ name: 'copy', secret: 'gh-api' }),
    ctx.client.grants.add({ name: 'dev', secret: 'npm' }),
  ]);

  const granted = await listGrantedRules(ctx.db, copy.id);

  const hosts = granted.map((each) => each.rule.host);

  const copied = await ctx.client.grants.list({ name: 'copy' });

  const skipped = ctx.logs.filter((line) => line.includes('forked without grant'));

  // the copy, the fork's own grant and the skip log follow from one serial
  // order (copy first, or the fork's gh-api first; npm before or after), so
  // they are checked together
  const outcome: unknown = {
    copy: results[0],
    forkGrant: results[1],
    copied,
    skipped,
  };

  expect(outcome).toBeOneOf([
    {
      copy: { status: 'fulfilled', value: { notCopied: [], error: null } },
      forkGrant: { status: 'rejected', reason: expect.toContainEntry(['code', 'CONFLICT']) },
      copied: ['gh'],
      skipped: [],
    },
    {
      copy: { status: 'fulfilled', value: { notCopied: [], error: null } },
      forkGrant: { status: 'rejected', reason: expect.toContainEntry(['code', 'CONFLICT']) },
      copied: ['gh', 'npm'],
      skipped: [],
    },
    {
      copy: {
        status: 'fulfilled',
        value: { notCopied: [{ secret: 'gh', reason: 'clash' }], error: null },
      },
      forkGrant: { status: 'fulfilled', value: {} },
      copied: ['gh-api'],
      skipped: [
        'impd: copy: forked without grant gh of dev: it has another credential for that host',
      ],
    },
    {
      copy: {
        status: 'fulfilled',
        value: { notCopied: [{ secret: 'gh', reason: 'clash' }], error: null },
      },
      forkGrant: { status: 'fulfilled', value: {} },
      copied: ['gh-api', 'npm'],
      skipped: [
        'impd: copy: forked without grant gh of dev: it has another credential for that host',
      ],
    },
  ]);

  expect(results[2]).toStrictEqual({ status: 'fulfilled', value: {} });
  expect(new Set(hosts).size).toBe(hosts.length);
});

test('it drops the old grant of a rebind onto a host granted before it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'other' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race-2',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
    replace: true,
    rebind: true,
  });

  const left = await ctx.client.grants.list({ name: 'dev' });

  expect(left).toStrictEqual(['gh']);
});

test('it grants a host after a rebind onto it dropped the old grant', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'other' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race-2',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
    replace: true,
    rebind: true,
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const left = await ctx.client.grants.list({ name: 'dev' });

  expect(left).toStrictEqual(['gh']);
});

test('it ends a rebind and a revoke made at once with no grant left', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'other' });

  const results: unknown = await Promise.allSettled([
    ctx.client.secrets.add({
      name: 'other',
      kind: 'custom',
      value: 'sk-synthetic-race-2',
      rules: [buildMockBrokerRule({ host: 'api.github.com' })],
      replace: true,
      rebind: true,
    }),
    ctx.client.grants.delete({ name: 'dev', secret: 'other' }),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });

  // revoke first, then a rebind with nothing to drop; or the rebind drops
  // the grant and the revoke finds none
  expect(results).toBeOneOf([
    [
      {
        status: 'fulfilled',
        value: {
          name: 'other',
          kind: 'custom',
          rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
          imps: [],
          createdAt: expect.any(Date) as unknown,
          droppedGrants: 0,
        },
      },
      { status: 'fulfilled', value: {} },
    ],
    [
      {
        status: 'fulfilled',
        value: {
          name: 'other',
          kind: 'custom',
          rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
          imps: [],
          createdAt: expect.any(Date) as unknown,
          droppedGrants: 1,
        },
      },
      { status: 'rejected', reason: expect.toContainEntry(['code', 'NOT_FOUND']) },
    ],
  ]);

  expect(left).toStrictEqual([]);
});

test('it keeps the grant that was there when a clashing one is refused', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const clash = ctx.client.grants.add({ name: 'dev', secret: 'gh-api' });

  expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });

  const kept = await ctx.client.grants.list({ name: 'dev' });

  expect(kept).toStrictEqual(['gh']);
});

test('it makes one row for the same grant made twice at once', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  const results = await Promise.all([
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
  ]);

  const rows = await listGrantNames(ctx.db, dev.id);

  expect(results).toStrictEqual([{}, {}]);
  expect(rows).toStrictEqual(['gh-api']);
});
