import { expect, onTestFinished, test } from 'bun:test';
import type { ImpEvent } from '@impz/api';
import { createImpClient } from '@impz/client';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockLeaseRecord } from '../../../testing/imps/build-mock-lease-record';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { startTestImpd } from '../../../testing/start-test-impd';
import { TEST_TOKEN } from '../../../testing/test-token';
import { listLeases, writeLease } from '../../platform/db/leases';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const leaseReads = buildQueryGate('imp_leases');

  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    frozenClockMs: Date.UTC(2026, 0, 1),
    wrapDatabase: leaseReads.wrap,
  });

  const events: ImpEvent[] = [];

  const unsubscribe = harness.imps.events.subscribe((event) => {
    events.push(event);
  });

  stack.defer(unsubscribe);

  const sendToImpd = (request: Request) => harness.impd.api.app.handle(request);

  return Object.assign(harness, {
    events,
    leaseReads,
    sendToImpd,
    client: createImpClient({ url: 'http://impd.test', token: TEST_TOKEN, fetch: sendToImpd }),
  });
}

test('it answers an acquire with the lease’s owner and end', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const leased = await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const principal = ctx.impd.tokens.authenticate(made.secret)?.principal;

  invariant(typeof principal === 'string');

  expect(leased).toStrictEqual({
    name: 'dev',
    owner: {
      principal,
      display: 'a',
      label: 'job',
    },
    until: new Date(ctx.now() + 60_000),
  });
});

test('it lists a token only its own leases', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await second.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const seen = await first.leases.list({});

  expect(seen.map((lease) => lease.owner.display)).toStrictEqual(['a']);
});

test('it lists root every owner’s lease', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await second.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const seen = await ctx.client.leases.list({ name: 'dev' });

  expect(seen.map((lease) => lease.owner.display).toSorted()).toStrictEqual(['a', 'b']);
});

test('it names a token’s own leases on the imp and counts the others', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await second.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const imp = await first.imps.get({ name: 'dev' });

  expect(imp.leases?.leases.map((lease) => lease.owner.display)).toStrictEqual(['a']);
  expect(imp.leases?.otherCount).toBe(1);
});

test('it names every lease on the imp to root and holds it until the longest ends', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await second.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.leases?.otherCount).toBe(0);
  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 120_000));
});

test('it releases only the caller’s own lease', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await second.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const released = await first.leases.release({ name: 'dev', label: 'job' });
  const left = await ctx.client.leases.list({});

  expect(released).toStrictEqual({ released: true });
  expect(left.map((lease) => lease.owner.display)).toStrictEqual(['b']);
});

test('it answers a release of a lease already released with released false', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.client.leases.release({ name: 'dev', label: 'job' });

  const again = await ctx.client.leases.release({ name: 'dev', label: 'job' });

  expect(again).toStrictEqual({ released: false });
});

test('it moves the end of a live lease on a renew', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  ctx.advance(20_000);

  const renewed = await ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 30 });

  expect(renewed.until).toStrictEqual(new Date(ctx.now() + 30_000));
});

test('it never shortens a lease on a renew with a shorter ttl', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const leased = await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });
  const kept = await ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 10 });

  expect(kept.until).toStrictEqual(leased.until);
});

test('it refuses a renew of an ended lease and wakes nothing', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  ctx.advance(30_000);

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(
    ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 30 }),
  ).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });

  const imp = await ctx.client.imps.get({ name: 'dev' });
  const leases = await ctx.client.leases.list({});

  expect(imp.state).toBe('sleeping');
  expect(imp.holdUntil).toBeUndefined();
  expect(leases).toStrictEqual([]);
});

test('it wakes a sleeping imp on an acquire', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});

test('it emits held with the lease counts but no owners on an acquire', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const held = await waitFor(() => {
    const found = ctx.events.find((event) => event.ev === 'ImpChanged' && event.reason === 'held');

    expect(found).toBeDefined();

    return found;
  });

  expect(held).toMatchObject({ imp: { leases: { leases: [], otherCount: 1 } } });
});

test('it refuses a lease with the label hold', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  expect(
    ctx.client.leases.acquire({ name: 'dev', label: 'hold', ttlSeconds: 60 }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses another token’s sleep of a leased imp with LEASED and hides the owner', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  expect(second.imps.sleep({ name: 'dev' })).rejects.toMatchObject({
    code: 'LEASED',
    data: { leases: [], otherCount: 1 },
  });
});

test('it refuses the owner’s stop of a leased imp with LEASED naming its lease', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const caller = ctx.impd.tokens.authenticate(made.secret);

  invariant(caller);

  expect(first.imps.stop({ name: 'dev' })).rejects.toMatchObject({
    code: 'LEASED',
    data: {
      leases: [
        {
          owner: { principal: caller.principal, label: 'job' },
        },
      ],
      otherCount: 0,
    },
  });
});

test('it refuses root’s sleep of a leased imp with LEASED and keeps it running', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  expect(ctx.client.imps.sleep({ name: 'dev' })).rejects.toMatchObject({
    code: 'LEASED',
    data: { otherCount: 0 },
  });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});

test('it ends every lease on a forced sleep and keeps the holds', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await first.leases.acquire({ name: 'dev', label: 'other', ttlSeconds: 60 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const asleep = await ctx.client.imps.sleep({ name: 'dev', force: true });
  const leases = await ctx.client.leases.list({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
  expect(asleep.holdUntil).toStrictEqual(new Date(ctx.now() + 600_000));
  expect(leases.map((lease) => lease.owner.label)).toStrictEqual(['hold']);
});

test('it emits released with the count of leases a forced sleep ended', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await first.leases.acquire({ name: 'dev', label: 'other', ttlSeconds: 60 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  const released = await waitFor(() => {
    const found = ctx.events.find(
      (event) => event.ev === 'ImpChanged' && event.reason === 'released',
    );

    expect(found).toBeDefined();

    return found;
  });

  expect(released).toMatchObject({ detail: { released: 2 } });
});

test('it refuses a renew of a lease a forced sleep ended', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  expect(first.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it sleeps a held imp on a sleep without force', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
});

test('it stops a held imp and keeps the hold', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const stopped = await ctx.client.imps.stop({ name: 'dev' });

  expect(stopped.state).toBe('stopped');
  expect(stopped.holdUntil).toStrictEqual(new Date(ctx.now() + 600_000));
});

test('it releases the caller’s hold and a legacy one on hold 0, and keeps the others', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });
  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const second = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await first.imps.hold({ name: 'dev', seconds: 600 });
  await second.imps.hold({ name: 'dev', seconds: 900 });
  await second.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const at = ctx.now();

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: created.id,
      principal: 'legacy',
      label: 'hold',
      until: new Date(at + 300_000),
    }),
    { at, reason: null },
  );

  await first.imps.hold({ name: 'dev', seconds: 0 });

  const left = await listLeases(ctx.db, ctx.now());

  const callerB = ctx.impd.tokens.authenticate(madeB.secret);

  invariant(callerB);

  expect(left.map((lease) => `${lease.principal}/${lease.label}`)).toStrictEqual([
    `${callerB.principal}/hold`,
    `${callerB.principal}/job`,
  ]);
});

test('it gives a new token with a deleted token’s name another principal', async () => {
  const ctx = await setupTest();
  const first = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const firstCaller = ctx.impd.tokens.authenticate(first.secret);

  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const secondCaller = ctx.impd.tokens.authenticate(second.secret);

  invariant(firstCaller);
  invariant(secondCaller);

  expect(secondCaller.principal).not.toBe(firstCaller.principal);
});

test('it lists a new token with a deleted token’s name none of its leases', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const first = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  await createImpClient({
    url: 'http://impd.test',
    token: first.secret,
    fetch: ctx.sendToImpd,
  }).leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const seen = await createImpClient({
    url: 'http://impd.test',
    token: second.secret,
    fetch: ctx.sendToImpd,
  }).leases.list({});

  expect(seen).toStrictEqual([]);
});

test('it refuses a renew by a new token of a deleted token’s lease', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const first = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  await createImpClient({
    url: 'http://impd.test',
    token: first.secret,
    fetch: ctx.sendToImpd,
  }).leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const client = createImpClient({
    url: 'http://impd.test',
    token: second.secret,
    fetch: ctx.sendToImpd,
  });

  expect(client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it leaves out of a list the imps a limited caller may not reach', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 60 });
  await limited.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 });

  const all = await limited.leases.list({});

  expect(all.map((lease) => lease.name)).toStrictEqual(['dev-a']);
});

test('it refuses a limited caller the leases of an imp it may not reach', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(limited.leases.list({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it sleeps a leased imp in the shutdown pass and keeps its lease', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.impd.imps.sleepAllImps();

  const leases = await listLeases(ctx.db, ctx.now());

  expect(ctx.fake.alive.size).toBe(0);
  expect(leases.map((lease) => lease.label)).toStrictEqual(['job']);
});

test('it names only the protected imps the caller may read in a RAM refusal', async () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '800');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.sleep({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.leases.acquire({ name: 'dev-b', label: 'job', ttlSeconds: 600 });
  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 600 });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(
    limited.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 }),
  ).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: {
      budgetMib: 800,
      neededMib: 100,
      protected: [{ name: 'dev-b', ramMib: 300, leased: true, busy: false }],
      protectedHidden: 1,
    },
  });

  const leases = await ctx.client.leases.list({ name: 'dev-a' });

  expect(leases).toStrictEqual([]);
});

test('it emits the governor’s refusal with every protected imp counted', async () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '800');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.sleep({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.leases.acquire({ name: 'dev-b', label: 'job', ttlSeconds: 600 });
  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 600 });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(
    limited.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const decision = await waitFor(() => {
    const found = ctx.events.find(
      (event) => event.ev === 'GovernorDecision' && event.decision === 'refused',
    );

    expect(found).toBeDefined();

    return found;
  });

  expect(decision).toMatchObject({ neededMib: 100, protectedCount: 2 });
});

test('it holds the imp until the longest of its leases ends', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 60 });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 600_000));
});

test('it moves the imp’s hold out when a renew makes a lease the longest', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 60 });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.leases.renew({ name: 'dev', label: 'short', ttlSeconds: 900 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 900_000));
});

test('it moves the imp’s hold in when the longest lease is released', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 900 });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.leases.release({ name: 'dev', label: 'short' });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 600_000));
});

test('it keeps the imp held by its leases when the caller’s hold is released', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 30 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 600_000));
});

test('it holds the imp by root’s hold alone after a forced sleep ends its leases', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const first = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await first.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 30 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 30_000));
});

test('it keeps the leases and emits no release when a forced sleep fails', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  ctx.fake.queue('sleep', 'fail');

  const failure = await ctx.client.imps.sleep({ name: 'dev', force: true }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'ImpChanged', reason: 'held' });
  });

  const leases = await ctx.client.leases.list({ name: 'dev' });
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(failure).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(leases.map((lease) => lease.owner.label)).toStrictEqual(['job']);
  expect(imp.holdUntil).toStrictEqual(new Date(ctx.now() + 60_000));
  expect(ctx.events).not.toPartiallyContain({ ev: 'ImpChanged', reason: 'released' });
  expect(ctx.rpcFailures).toMatchObject([{ message: 'snapshot failed' }]);
});

test('it answers a sleep of a leased imp the shutdown pass slept', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 600 });
  await ctx.impd.imps.sleepAllImps();

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
});

test('it answers a stop of a stopped imp another owner leases and keeps the lease', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 1, 12));

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });

  const at = ctx.now();

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: created.id,
      principal: 'token:other',
      label: 'job',
      until: new Date(at + 600_000),
    }),
    { at, reason: null },
  );

  const stopped = await ctx.client.imps.stop({ name: 'dev' });
  const leases = await listLeases(ctx.db, ctx.now());

  expect(stopped.state).toBe('stopped');
  expect(leases.map((lease) => lease.principal)).toStrictEqual(['token:other']);
});

test('it emits held on hold 0 even when it releases nothing', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  const held = await waitFor(() => {
    const found = ctx.events.filter(
      (event) => event.ev === 'ImpChanged' && event.reason === 'held',
    );

    expect(found).not.toBeEmpty();

    return found;
  });

  expect(held).toMatchObject([{ ev: 'ImpChanged', reason: 'held' }]);
});

test('it names an imp’s lease owners as of the one read that shows the imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  ctx.leaseReads.arm();

  const getting = ctx.client.imps.get({ name: 'dev' });

  await ctx.leaseReads.reached;

  await ctx.client.leases.acquire({ name: 'dev', label: 'late', ttlSeconds: 60 });

  ctx.leaseReads.release();

  const imp = await getting;

  expect(imp.leases?.leases.map((lease) => lease.owner.label)).toStrictEqual(['job']);
});
