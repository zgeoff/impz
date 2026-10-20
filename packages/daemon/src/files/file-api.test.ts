import { expect, onTestFinished, test } from 'bun:test';
import { buildMockNewImage } from '../../testing/imps/build-mock-new-image';
import { startTestImpd } from '../../testing/start-test-impd';
import { startStubFilesAgent } from '../../testing/vm/start-stub-files-agent';
import { createImage } from '../db/images';
import { buildImagePaths, buildImpPaths } from '../storage/data-layout';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  // the default image, which every create without an image boots
  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  // assigned, not spread: a spread reads the harness's parts once
  return Object.assign(harness, { stack });
}

test('it writes a file through the agent and answers its guest path', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const written = await ctx.client.files.write({
    name: 'dev',
    path: 'notes/today.json',
    content: '{"title":"kettle"}',
  });

  expect(written).toStrictEqual({ path: '/run/imp/files/notes/today.json' });
  expect([...agent.files]).toStrictEqual([['notes/today.json', '{"title":"kettle"}']]);
});

test('it removes a file through the agent and reports that it was there', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  agent.files.set('notes/today.json', '{}');

  const removed = await ctx.client.files.remove({ name: 'dev', path: 'notes/today.json' });

  expect(removed).toStrictEqual({ removed: true });
  expect(agent.files.size).toBe(0);
});

test('it reports a remove of a missing file as not removed', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const removed = await ctx.client.files.remove({ name: 'dev', path: 'notes/today.json' });

  expect(removed).toStrictEqual({ removed: false });
});

test('it refuses a path outside the rule before it reaches the agent', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  expect(
    ctx.client.files.write({ name: 'dev', path: '../etc/passwd', content: 'x' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  expect(agent.requests).toStrictEqual([]);
});

test('it refuses a write to a full tree as BAD_REQUEST with the agent’s reason', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  agent.full.isFull = true;

  expect(
    ctx.client.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'the read-only files are full' });
});

test('it refuses a write on an agent from before the read-only files as AGENT_OUTDATED', async () => {
  const ctx = await setupTest();

  // each boot and wake reports it
  ctx.fake.agent.version = '0.18.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: false,
    stack: ctx.stack,
  });

  expect(
    ctx.client.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.requests).toStrictEqual([]);
});

test('it lets an exec-scope token write a file', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  await exec.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' });

  expect([...agent.files.keys()]).toStrictEqual(['notes/today.json']);
});

test('it refuses a read-scope token’s write as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.fake.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'viewer', scope: 'read' });

  const read = ctx.buildClient(token.secret);

  expect(
    read.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(agent.requests).toStrictEqual([]);
});
