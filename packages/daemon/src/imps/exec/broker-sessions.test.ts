import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { startTestImpd } from '../../../testing/start-test-impd';
import { startStubSessionAgent } from '../../../testing/vm/start-stub-session-agent';
import { readVmIdentity, writeVmIdentity } from '../../vm/sleep/vm-identity';
import { buildImpPaths } from '../../vm/storage/data-layout';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  return Object.assign(harness, { stack });
}

test('it refuses to start a session that requires the broker without a grant', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'main', require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the imp has no grant, so impd sets no broker variables',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it passes an attach that requires the broker to a session started with it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const started = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  started.close();

  const attached = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  attached.close();

  expect(attached.created).toBeFalse();
  expect(agent.readExecs()).toHaveLength(2);
});

test('it refuses an attach that requires the broker to a session started without it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const plain = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other' });

  ctx.stack.defer(() => {
    plain.close();
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other', require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'session other was started without the broker requirement',
    },
  });

  expect(agent.readExecs()).toHaveLength(1);
});

test('it leaves the viewer of a session its output after a refused attach', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const plain = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other' });

  ctx.stack.defer(() => {
    plain.close();
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other', require: ['broker'] }),
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

  agent.writeOutput('other', Buffer.from('still'));

  const first = await plain.events().next();

  expect(first.value).toStrictEqual({ type: 'stdout', data: Buffer.from('still') });
});

test('it passes an attach that requires the broker after an impd restart', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const started = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  started.close();

  const restarted = await ctx.restartImpd();

  const resumed = await restarted.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  resumed.close();

  expect(resumed.created).toBeFalse();
  expect(agent.readExecs()).toHaveLength(2);
});

test('it refuses an attach that requires the broker to a session a cold boot started without it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const started = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  started.close();

  const restarted = await ctx.restartImpd();

  await restarted.imps.lockImp('dev', async (locked) => {
    const halted = await restarted.imps.haltImp(locked, false);

    await restarted.imps.bootImp(halted);
  });

  agent.clearRuns();

  const booted = readVmIdentity(paths);

  invariant(booted);
  writeVmIdentity(paths, { ...booted, agentVersion: '0.16.0' });

  const plain = await restarted.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'main' });

  plain.close();

  expect(
    restarted.imps.openExec('dev', {
      argv: ['sh'],
      tty: true,
      session: 'main',
      require: ['broker'],
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'session main was started without the broker requirement',
    },
  });
});

test('it keeps the record of an exited run while it is listed, so a resume of it passes', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const first = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  first.close();

  const run = agent.readRun('main');

  invariant(run);

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  agent.exitRun('main', { code: 0, signal: 0 });

  const other = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'other',
    require: ['broker'],
  });

  other.close();

  const resumed = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
    resumeFrom: { executionGeneration: run.generation, offset: 0 },
  });

  resumed.close();

  expect(resumed.created).toBeFalse();
  expect(agent.readExecs()).toHaveLength(3);
});

test('it refuses a resume of an exited run started without the requirement before the agent', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const plain = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'job' });

  plain.close();

  const run = agent.readRun('job');

  invariant(run);

  await waitFor(() => {
    expect(agent.readRun('job')?.isAttached).toBeFalse();
  });

  agent.exitRun('job', { code: 0, signal: 0 });

  expect(
    ctx.imps.openExec('dev', {
      argv: ['sh'],
      tty: true,
      session: 'job',
      require: ['broker'],
      resumeFrom: { executionGeneration: run.generation, offset: 0 },
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'session job was started without the broker requirement',
    },
  });

  expect(agent.readExecs()).toHaveLength(1);
});
