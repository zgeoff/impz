import { expect, jest, onTestFinished, test } from 'bun:test';
import type { ImpContract, ImpEvent } from '@impz/api';
import { pruneEvents } from '@impz/durable';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import invariant from 'tiny-invariant';
import { P, match } from 'ts-pattern';
import { ROOT_TOKEN_ID } from '../identity/auth/token-store';
import { listApiCalls } from '../platform/db/api-audit';
import { readImpByName } from '../platform/db/imps';
import { withImpTransaction } from '../platform/db/with-imp-transaction';
import { buildSessionValue } from '../platform/http/session-cookie';
import { readInBackground } from '../test-utils/platform/read-in-background';
import { readQueuedText } from '../test-utils/platform/read-queued-text';
import { startTestImpd } from '../test-utils/start-test-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    frozenClockMs: Date.UTC(2026, 0, 1),
    rootToken: 'root-token',
  });

  return Object.assign(harness, {
    readHead: () => harness.impd.db.log.readHead(),
    pruneEvents: (now: number) =>
      withImpTransaction(harness.impd.db, (trx) => pruneEvents(trx, now)),
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

  // the stream's first read may leave the position after the empty snapshot queued
  const frames = queued
    .split('\n\n')
    .filter((frame) => frame !== '' && !frame.includes('Position'));

  expect(frames).toHaveLength(80);
  expect(frames).toSatisfyAll((frame: string) => frame === ': ');
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
    { ev: 'Position' },
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

// the restarted impd adopts during its boot, before a stream could open, so the event shows only
// in the log
test('it logs an adopted change when a restarted impd adopts a running VM', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'alive', image: 'ubuntu' });

  const head = await ctx.db.log.readHead();

  await ctx.restartImpd();

  const read = await ctx.db.log.readAfter(head, 100);

  invariant(read.kind === 'events');

  expect(read.events).toPartiallyContain({
    ev: 'ImpChanged',
    reason: 'adopted',
    imp: expect.objectContaining({ name: 'alive', state: 'running' }),
  });
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

  expect(tokenStream.items.slice(0, 2)).toMatchObject([
    { ev: 'Position' },
    { ev: 'ImpAdded', reason: 'created', imp: { name: 'dev' } },
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

  // the stream reads from the head it takes as it opens, so an event shows only once it reads
  await waitFor(async () => {
    await ctx.impd.imps.events.write(
      {
        ev: 'GovernorDecision',
        decision: 'admitted',
        name: 'before',
        trigger: 'wake',
        usedMib: 512,
        budgetMib: 4096,
      },
      ctx.now(),
    );

    expect(stream.items).not.toBeEmpty();
  });

  // no imp is named with a space
  await ctx.impd.imps.events.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'boot template',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    ctx.now(),
  );

  await ctx.impd.imps.events.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'after',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    ctx.now(),
  );

  await waitFor(() => {
    expect(stream.items).toPartiallyContain({ name: 'after' });
  });

  controller.abort();

  expect(stream.items.map((event) => ('name' in event ? event.name : event.ev))).not.toContain(
    'boot template',
  );

  expect(ctx.logs.filter((line) => line.includes('fail the event schema'))).toStrictEqual([
    'INFO impd.events dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
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

  await waitFor(() => {
    expect(stream.items).not.toBeEmpty();
  });

  await ctx.impd.imps.events.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'later',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    ctx.now(),
  );

  await waitFor(() => {
    expect(stream.items).toHaveLength(3);
  });

  controller.abort();

  expect(stream.items).toMatchObject([
    { ev: 'ImpAdded', reason: 'snapshot', imp: { name: 'good' } },
    { ev: 'Position' },
    { ev: 'GovernorDecision', name: 'later' },
  ]);
});

test('it sends a stream that resumes across an impd restart every event it missed', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const seen = await ctx.client.events.list({});

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.restartImpd();
  await ctx.client.imps.wake({ name: 'dev' });

  const head = await ctx.readHead();

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const stream = await ctx.client.events.stream(
    { after: seen.after, logId: seen.logId },
    { signal: controller.signal },
  );

  const read = readInBackground(stream);

  const missed = await waitFor(() => {
    expect(read.items).toHaveLength(head - seen.after);

    return read.items;
  });

  controller.abort();

  expect(missed.map((event) => event.seq)).toStrictEqual(
    Array.from({ length: head - seen.after }, (_unused, index) => seen.after + 1 + index),
  );
});

test('it lists the snapshot at the head for a reader with no cursor', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const head = await ctx.readHead();
  const page = await ctx.client.events.list({});

  expect(page).toStrictEqual({
    events: [
      expect.objectContaining({ ev: 'ImpAdded', reason: 'snapshot', seq: head, logId: page.logId }),
    ],
    after: head,
    logId: expect.toBeString(),
    hasMore: false,
  });
});

test('it lists the events after a cursor a page at a time', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const seen = await ctx.client.events.list({});

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const page = await ctx.client.events.list({ after: seen.after, logId: seen.logId, limit: 1 });

  expect(page).toStrictEqual({
    events: [expect.objectContaining({ ev: 'ImpAdded', reason: 'created', seq: seen.after + 1 })],
    after: seen.after + 1,
    logId: seen.logId,
    hasMore: true,
  });
});

test('it lists a reset, then the snapshot, for a cursor from another log', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const head = await ctx.readHead();
  const page = await ctx.client.events.list({ after: 1, logId: 'log-from-a-restored-copy' });

  expect(page.events).toStrictEqual([
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    { v: 1, at: expect.toBeValidDate(), seq: head, logId: page.logId, ev: 'Reset' },
    expect.objectContaining({ ev: 'ImpAdded', reason: 'snapshot', seq: head }),
  ]);
});

test('it lists a reset, then the snapshot, for a cursor older than the oldest event it keeps', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const seen = await ctx.client.events.list({});

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.pruneEvents(ctx.now() + 8 * 86_400_000);

  const head = await ctx.readHead();
  const page = await ctx.client.events.list({ after: seen.after, logId: seen.logId });

  expect(page).toStrictEqual({
    events: [
      // oxlint-disable-next-line id-length -- `v` is the event format's version field
      { v: 1, at: expect.toBeValidDate(), seq: head, logId: seen.logId, ev: 'Reset' },
      expect.objectContaining({ ev: 'ImpAdded', reason: 'snapshot', seq: head }),
    ],
    after: head,
    logId: seen.logId,
    hasMore: false,
  });
});

test('it lists only the imps a limited token may see in a snapshot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'read', imps: ['dev-*'] });
  const page = await ctx.buildClient(made.secret).events.list({});

  expect(page.events).toStrictEqual([
    expect.objectContaining({ ev: 'ImpAdded', imp: expect.objectContaining({ name: 'dev-a' }) }),
  ]);
});

test('it lists only the events of the imps a limited token may see after a cursor', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'read', imps: ['dev-*'] });

  const dev = ctx.buildClient(made.secret);

  const seen = await dev.events.list({});

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const page = await dev.events.list({ after: seen.after, logId: seen.logId });

  const names = page.events.map((event) =>
    match(event)
      .with({ ev: P.union('Reset', 'Position') }, (cursor) => cursor.ev)
      .with({ ev: P.union('ImpAdded', 'ImpChanged', 'ImpRemoved') }, (changed) => changed.imp.name)
      .otherwise((named) => named.name),
  );

  expect(names).toSatisfyAll((name: string) => name === 'dev-a');
  expect(page.events).toPartiallyContain({ ev: 'ImpAdded', reason: 'created' });
});

test('it sends a limited token the position past the events it may not see', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'read', imps: ['dev-*'] });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx
    .buildClient(made.secret)
    .events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  await waitFor(() => {
    expect(stream.items).toPartiallyContain({ ev: 'Position' });
  });

  await ctx.client.imps.create({ name: 'prod' });

  const head = await ctx.readHead();

  await waitFor(() => {
    expect(stream.items.at(-1)).toMatchObject({ ev: 'Position', seq: head });
  });

  controller.abort();

  expect(stream.items).toSatisfyAll((event: ImpEvent) => event.ev === 'Position');
});
