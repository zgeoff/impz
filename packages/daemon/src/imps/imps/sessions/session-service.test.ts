import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { startTestImpd } from '../../../../testing/start-test-impd';
import { startStubSessionAgent } from '../../../../testing/vm/start-stub-session-agent';
import { readImpByName } from '../../../platform/db/imps';
import { sendActivity } from '../../../vm/agent-client/agent-requests';
import { openExecStream } from '../../../vm/agent-client/exec-stream';
import { readSnapshotMeta } from '../../../vm/sleep/snapshot-meta';
import { buildImpPaths } from '../../../vm/storage/data-layout';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  return Object.assign(harness, { stack });
}

test('it lists a running imp’s sessions from an agent from before output offsets', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  const agent = await startStubSessionAgent(vsockPath, {
    release: 'before-offsets',
    stack: ctx.stack,
  });

  const main = await openExecStream(vsockPath, {
    argv: ['sh'],
    tty: true,
    cols: 120,
    rows: 40,
    session: 'main',
  });

  ctx.stack.defer(() => {
    main.close();
  });

  const job = await openExecStream(vsockPath, {
    argv: ['make'],
    tty: true,
    cols: 80,
    rows: 24,
    session: 'job',
  });

  job.close();

  await waitFor(() => {
    expect(agent.readRun('job')?.isAttached).toBeFalse();
  });

  agent.exitRun('job', { code: 137, signal: 9 });

  const sessions = await ctx.client.sessions.list({ name: 'dev' });

  expect(sessions).toStrictEqual([
    {
      name: 'job',
      pid: 9,
      argv: ['make'],
      state: 'exited',
      attached: false,
      cols: 80,
      rows: 24,
      startedAt: expect.toBeValidDate(),
      exit: { code: null, signal: 'SIGKILL' },
      continuity: 'none',
    },
    {
      name: 'main',
      pid: 9,
      argv: ['sh'],
      state: 'running',
      attached: true,
      cols: 120,
      rows: 40,
      startedAt: expect.toBeValidDate(),
      continuity: 'none',
    },
  ]);
});

test('it counts no sessions for an imp whose agent impd has not asked yet', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(got.sessions).toBeUndefined();
});

test('it counts an imp’s sessions on the imp and the host once it lists them', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const job = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'job' });

  ctx.stack.defer(() => {
    job.close();
  });

  await ctx.client.sessions.list({ name: 'dev' });

  const got = await ctx.client.imps.get({ name: 'dev' });
  const info = await ctx.client.system.info();

  expect(got.sessions).toBe(2);
  expect(info.sessionCount).toBe(2);
});

test('it records the sessions that the idle loop’s activity read finds', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  const activity = await ctx.impd.imps.readActivity(record);
  const listed = await ctx.client.imps.list();

  expect(activity?.sessions.map((session) => session.name)).toStrictEqual(['main']);
  expect(listed[0]?.sessions).toBe(1);
});

test('it records a sleeping imp’s sessions as detached in its snapshot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const seen = await sendActivity(vsockPath);

  const [attached] = seen.sessions;

  invariant(attached);

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(buildImpPaths(ctx.dataDir, imp.id));

  expect(attached.attached).toBeTrue();

  expect(meta?.sessions).toStrictEqual([
    { ...attached, attached: false, observedUnixMs: expect.toBeNumber() },
  ]);
});

test('it lists a sleeping imp’s sessions without a wake', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  const sessions = await ctx.client.sessions.list({ name: 'dev' });
  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(sessions.map((session) => [session.name, session.attached])).toStrictEqual([
    ['main', false],
  ]);

  expect(got.state).toBe('sleeping');
  expect(got.sessions).toBe(1);
  expect(ctx.fake.wakes).toStrictEqual([]);
});

test('it lists no sessions for a stopped imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  await ctx.client.sessions.list({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const sessions = await ctx.client.sessions.list({ name: 'dev' });
  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(sessions).toStrictEqual([]);
  expect(got.sessions).toBe(0);
});

test('it wakes a sleeping imp for a kill, and ends the session', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  const agent = await startStubSessionAgent(vsockPath, { stack: ctx.stack });
  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const other = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'other' });

  ctx.stack.defer(() => {
    other.close();
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.sessions.kill({ name: 'dev', session: 'main' });

  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(agent.readRun('main')).toBeUndefined();
  expect(agent.readRun('other')?.state).toBe('running');
  expect(got.state).toBe('running');
});

test('it drops a killed session from the sessions impd keeps', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  await startStubSessionAgent(vsockPath, { stack: ctx.stack });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const other = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'other' });

  ctx.stack.defer(() => {
    other.close();
  });

  await ctx.client.sessions.list({ name: 'dev' });
  await ctx.client.sessions.kill({ name: 'dev', session: 'main' });

  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(got.sessions).toBe(1);
});

test('it refuses a kill of a session the agent lacks as NOT_FOUND', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  expect(ctx.client.sessions.kill({ name: 'dev', session: 'main' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'session', name: 'main' },
  });
});

test('it refuses a kill on an agent from before sessions as AGENT_OUTDATED', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    release: 'before-sessions',
    stack: ctx.stack,
  });

  expect(ctx.client.sessions.kill({ name: 'dev', session: 'main' })).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    status: 409,
  });
});

test('it refuses a list of an unknown imp as NOT_FOUND', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sessions.list({ name: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'nope' },
  });
});

test('it lists a session’s generation, and its end as last seen, from an agent with offsets', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  const agent = await startStubSessionAgent(vsockPath, {
    bootId: '22222222-2222-4222-8222-222222222222',
    stack: ctx.stack,
  });

  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  agent.writeOutput('main', Buffer.alloc(4096));

  const run = agent.readRun('main');

  invariant(run);

  const before = Date.now();

  const [session] = await ctx.client.sessions.list({ name: 'dev' });

  expect(session).toMatchObject({
    continuity: 'offsets',
    executionGeneration: run.generation,
    bootId: '22222222-2222-4222-8222-222222222222',
    end: 4096,
    endObservedAt: expect.toBeAfter(new Date(before - 1)),
  });
});

test('it keeps a session’s generation and when impd saw its end across a sleep', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  const agent = await startStubSessionAgent(vsockPath, { stack: ctx.stack });
  const main = await openExecStream(vsockPath, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  agent.writeOutput('main', Buffer.alloc(4096));

  const run = agent.readRun('main');

  invariant(run);

  const [seen] = await ctx.client.sessions.list({ name: 'dev' });

  invariant(seen?.endObservedAt);

  await ctx.client.imps.sleep({ name: 'dev' });

  const [slept] = await ctx.client.sessions.list({ name: 'dev' });

  expect(slept).toMatchObject({
    continuity: 'offsets',
    executionGeneration: run.generation,
    end: 4096,
    endObservedAt: seen.endObservedAt,
  });
});
