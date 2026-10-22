import { expect, jest, onTestFinished, test } from 'bun:test';
import type { ImpContract, ImpEvent } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import invariant from 'tiny-invariant';
import { readInBackground } from '../../../testing/platform/read-in-background';
import { readQueuedText } from '../../../testing/platform/read-queued-text';
import { startTestImpd } from '../../../testing/start-test-impd';
import { buildMockGovernorDecision } from '../../../testing/vm/build-mock-governor-decision';
import { buildSessionValue } from '../../identity/auth/session-cookie';
import { ROOT_TOKEN_ID } from '../../identity/auth/token-store';
import { listApiCalls } from '../db/api-audit';
import type { ImpWrite } from '../db/imp-write-feed';
import { readImpByName } from '../db/imps';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack, {
    frozenClockMs: Date.UTC(2026, 0, 1),
    rootToken: 'root-token',
  });
}

// oRPC's keepalive is its own setInterval, so fake timers run 400 s of a
// stream with no event: past the 360 s Bun's fetch waits for a byte
test('it sends a keepalive comment every 5 s through a stream with no event', async () => {
  const ctx = await setupTest();

  jest.useFakeTimers();

  onTestFinished(() => {
    jest.useRealTimers();
  });

  const response = await ctx.impd.api.app.handle(
    new Request('http://impd.test/rpc/events/stream', {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', 'content-type': 'application/json' },
      body: '{}',
    }),
  );

  invariant(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  onTestFinished(() => reader.cancel());

  await reader.read();

  jest.advanceTimersByTime(400_000);
  jest.useRealTimers();

  const queued = await readQueuedText(reader, 1000);

  const keepalives = queued.split('\n\n').filter(Boolean);

  expect(keepalives).toHaveLength(80);
  expect(keepalives).toSatisfyAll((frame: string) => frame === ': ');
});

test('it sends the snapshot, then each change with its reason', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'old', image: 'ubuntu' });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });
  await ctx.client.imps.destroy({ name: 'dev' });

  await waitFor(() => {
    expect(stream.items).toPartiallyContain({ ev: 'ImpRemoved' });
  });

  controller.abort();

  await stream.ended;

  expect(stream.items).toMatchObject([
    { ev: 'ImpAdded', reason: 'snapshot', imp: { name: 'old' } },
    { ev: 'ImpAdded', reason: 'created', imp: { name: 'dev' } },
    { ev: 'GovernorDecision', decision: 'admitted', name: 'dev' },
    {
      ev: 'ImpChanged',
      reason: 'booted',
      imp: { name: 'dev' },
      detail: { durationMs: expect.toBeNumber() },
    },
    {
      ev: 'ImpChanged',
      reason: 'slept',
      imp: { name: 'dev' },
      detail: { durationMs: expect.toBeNumber(), trigger: 'requested' },
    },
    { ev: 'GovernorDecision', decision: 'admitted', name: 'dev' },
    {
      ev: 'ImpChanged',
      reason: 'woke',
      imp: { name: 'dev' },
      detail: { durationMs: expect.toBeNumber() },
    },
    { ev: 'ImpRemoved', imp: { name: 'dev' } },
  ]);
});

test('it counts a young guest’s wait before a sleep in the slept event’s prepareMs', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  // 200 ms short of the 1500 ms default minimum guest uptime: the sleep waits
  // the rest on the sleep clock before it pauses the VM, and the pause moves
  // that clock by nothing
  ctx.fake.setGuestUptime(1300);

  await ctx.client.imps.sleep({ name: 'dev' });

  const slept = await waitFor(() => {
    const found = stream.items.find(
      (event): event is Extract<ImpEvent, { ev: 'ImpChanged' }> =>
        event.ev === 'ImpChanged' && event.reason === 'slept',
    );

    invariant(found, 'no slept event yet');

    return found;
  });

  controller.abort();

  expect(slept.detail?.prepareMs).toBe(200);
  expect(slept.detail?.durationMs).toBe(0);
});

test('it sends a repaired event when a check finds an imp’s VM gone', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dead', image: 'ubuntu' });

  const dead = await readImpByName(ctx.db, 'dead');

  invariant(typeof dead?.pid === 'number');

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  ctx.fake.alive.delete(dead.pid);

  await ctx.client.imps.list();

  const repaired = await waitFor(() => {
    const found = stream.items.find(
      (event) => event.ev === 'ImpChanged' && event.reason === 'repaired',
    );

    invariant(found, 'no repaired event yet');

    return found;
  });

  controller.abort();

  expect(repaired).toMatchObject({ imp: { name: 'dead' } });
});

test('it reports an adopted change when a restarted impd adopts a running VM', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'alive', image: 'ubuntu' });

  // the restarted impd adopts during its boot, before anything could listen
  // on its event bus: the write its publisher turns into the event shows it
  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const restarted = await ctx.restartImpd();

  const bootChanges = writes
    .filter((write) => write.kind === 'changed')
    .map((write) => `${write.reason} ${write.imp.name}`);

  const events: ImpEvent[] = [];

  onTestFinished(
    restarted.imps.events.subscribe((event) => {
      events.push(event);
    }),
  );

  await restarted.imps.reconcileImps();

  const adopted = await waitFor(() => {
    const found = events.find((event) => event.ev === 'ImpChanged' && event.reason === 'adopted');

    invariant(found, 'no adopted event yet');

    return found;
  });

  expect(bootChanges).toContain('adopted alive');
  expect(adopted).toMatchObject({ imp: { name: 'alive', state: 'running' } });
});

test('it puts a secret’s value in no event and no audit row', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 4, 6, 7, 8, 9));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_secretvalue0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.imps.sleep({ name: 'dev' });

  await waitFor(() => {
    expect(stream.items).toPartiallyContain({ ev: 'ImpChanged', reason: 'slept' });
  });

  controller.abort();

  // each audit row lands after its call's answer
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, null, 100, null);

    expect(listed).toHaveLength(4);

    return listed;
  });

  expect(JSON.stringify(stream.items)).not.toInclude('ghp_secretvalue0123456789');
  expect(JSON.stringify(calls)).not.toInclude('ghp_secretvalue0123456789');

  // impd's clock is frozen, so every call takes 0 ms at the same time
  expect(calls).toStrictEqual([
    {
      procedure: 'imps.sleep',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'grants.add',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'secrets.add',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'imps.create',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      durationMs: 0,
      outcome: 'ok',
    },
  ]);
});

test('it ends a dashboard stream at the session’s expiry', async () => {
  const ctx = await setupTest();

  const expiresAt = ctx.now() + 1;
  const sendDashboardRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const dashboard: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie: `imp_session=${buildSessionValue('root-token', { tokenId: ROOT_TOKEN_ID, expiresAt })}`,
        'sec-fetch-site': 'same-origin',
      },
      fetch: sendDashboardRequest,
    }),
  );

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await dashboard.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  const ended = await stream.ended;

  expect(ended).toBeNull();
});

test('it ends a dashboard stream at any logout, and leaves a token’s stream open', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const expiresAt = ctx.now() + 60_000;
  const sendDashboardRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const dashboard: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie: `imp_session=${buildSessionValue('root-token', { tokenId: ROOT_TOKEN_ID, expiresAt })}`,
        'sec-fetch-site': 'same-origin',
      },
      fetch: sendDashboardRequest,
    }),
  );

  const dashboardController = new AbortController();

  onTestFinished(() => {
    dashboardController.abort();
  });

  const dashboardEvents = await dashboard.events.stream(undefined, {
    signal: dashboardController.signal,
  });

  const dashboardStream = readInBackground(dashboardEvents);

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const tokenEvents = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const tokenStream = readInBackground(tokenEvents);

  const logout = await dashboard.auth.logout();
  const dashboardEnded = await dashboardStream.ended;

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await waitFor(() => {
    expect(tokenStream.items).toPartiallyContain({ ev: 'ImpAdded' });
  });

  controller.abort();

  expect(logout).toStrictEqual({});
  expect(dashboardEnded).toBeNull();

  expect(tokenStream.items[0]).toMatchObject({
    ev: 'ImpAdded',
    reason: 'created',
    imp: { name: 'dev' },
  });
});

test('it records a dashboard session’s calls in the audit log as the dashboard’s', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 4, 6, 7, 8, 9));

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const expiresAt = ctx.now() + 60_000;
  const sendDashboardRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const dashboard: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie: `imp_session=${buildSessionValue('root-token', { tokenId: ROOT_TOKEN_ID, expiresAt })}`,
        'sec-fetch-site': 'same-origin',
      },
      fetch: sendDashboardRequest,
    }),
  );

  await dashboard.imps.stop({ name: 'dev' });

  // each audit row lands after its call's answer
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, null, 100, null);

    expect(listed).toHaveLength(2);

    return listed;
  });

  // impd's clock is frozen, so every call takes 0 ms at the same time
  expect(calls).toStrictEqual([
    {
      procedure: 'imps.stop',
      imp: 'dev',
      actor: 'dashboard',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'imps.create',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 4, 6, 7, 8, 9)),
      durationMs: 0,
      outcome: 'ok',
    },
  ]);
});

test('it drops an event that fails the schema and goes on', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);
  const good = buildMockGovernorDecision({ name: 'good' });
  const after = buildMockGovernorDecision({ name: 'after' });

  // no imp is named with a space
  ctx.impd.imps.events.publish(buildMockGovernorDecision({ name: 'boot template' }));
  ctx.impd.imps.events.publish(good);

  await waitFor(() => {
    expect(stream.items).not.toBeEmpty();
  });

  ctx.impd.imps.events.publish(after);

  await waitFor(() => {
    expect(stream.items).toHaveLength(2);
  });

  controller.abort();

  expect(stream.items).toStrictEqual([good, after]);

  expect(ctx.logs.filter((line) => line.includes('fail the event schema'))).toStrictEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);
});

test('it drops a snapshot imp that fails the schema and goes on', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'bad', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'good', image: 'ubuntu' });
  await ctx.db.updateTable('imps').set({ name: 'Bad Name' }).where('name', '=', 'bad').execute();

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);
  const later = buildMockGovernorDecision({ name: 'later' });

  await waitFor(() => {
    expect(stream.items).not.toBeEmpty();
  });

  ctx.impd.imps.events.publish(later);

  await waitFor(() => {
    expect(stream.items).toHaveLength(2);
  });

  controller.abort();

  expect(stream.items).toMatchObject([
    { ev: 'ImpAdded', reason: 'snapshot', imp: { name: 'good' } },
    later,
  ]);
});
