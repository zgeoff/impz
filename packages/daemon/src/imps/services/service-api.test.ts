import { expect, jest, onTestFinished, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import {
  ExitSchema,
  LogCursorSchema,
  RequestSchema,
  ServiceDefSchema,
  ServiceStatusSchema,
} from '@impz/agent-protocol';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { readInBackground } from '../../../testing/platform/read-in-background';
import { readQueuedText } from '../../../testing/platform/read-queued-text';
import { startTestImpd } from '../../../testing/start-test-impd';
import { TEST_TOKEN } from '../../../testing/test-token';
import { startStubServiceAgent } from '../../../testing/vm/start-stub-service-agent';
import { updateImpActivity } from '../../platform/db/imps';
import { readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { buildImpPaths } from '../../vm/storage/data-layout';
import { createServiceApi } from './service-api';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  return Object.assign(harness, { stack });
}

test('it sends the agent the service an add names, its env values included', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'web', argv: ['node', 'server.js'], env: ['PORT=3000', 'TOKEN=s3cret'] },
  });

  const added = agent.requests
    .filter((request) => request.op === 'services.add')
    .map((request) => request.def);

  expect(added).toStrictEqual([
    create(ServiceDefSchema, {
      name: 'web',
      argv: ['node', 'server.js'],
      env: ['PORT=3000', 'TOKEN=s3cret'],
    }),
  ]);
});

test('it lists an added service with its command, its source, and only its env keys', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'web', argv: ['node', 'server.js'], env: ['PORT=3000', 'TOKEN=s3cret'] },
  });

  const [web] = agent.services;

  invariant(web);

  agent.services[0] = { ...web, lastExit: create(ExitSchema, { code: 137, signal: 9 }) };

  const listed = await ctx.client.services.list({ name: 'dev' });

  expect(listed).toStrictEqual({
    services: [
      {
        name: 'web',
        state: 'running',
        pid: 40,
        restarts: 0,
        lastExit: { code: 137, signal: 'SIGKILL' },
        argv: ['node', 'server.js'],
        envKeys: ['PORT', 'TOKEN'],
        cwd: null,
        user: null,
        restart: 'always',
        source: 'api',
        root: false,
      },
    ],
    recorded: true,
  });
});

test('it refuses an add of a service that exists as CONFLICT', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  expect(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } }),
  ).rejects.toMatchObject({ code: 'CONFLICT', data: { kind: 'service', name: 'web' } });
});

test('it replaces a service that exists when the add replaces', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'web', argv: ['httpd', '-v'] },
    replace: true,
  });

  expect(agent.services.map((entry) => entry.def?.argv)).toStrictEqual([['httpd', '-v']]);
});

test('it returns the agent’s refusal of a command as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  expect(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['bad'] } }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a remove of a service the agent lacks as NOT_FOUND', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  expect(ctx.client.services.remove({ name: 'dev', service: 'web' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'service', name: 'web' },
  });
});

test('it refuses a restart of a service the agent lacks as NOT_FOUND', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  expect(ctx.client.services.restart({ name: 'dev', service: 'web' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'service', name: 'web' },
  });
});

test.each([
  ['../x', 'a path'],
  ['a_b', 'an underscore'],
  ['a.b', 'a dot'],
  ['Web', 'a capital'],
  [`a${'b'.repeat(63)}`, '64 characters'],
])('it refuses the service name %s, with %s, before the agent', async (service) => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const added = ctx.client.services.add({ name: 'dev', service: { name: service, argv: ['x'] } });

  expect(added).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(agent.requests).toStrictEqual([]);
});

test('it refuses a remove of a service name with a slash before the agent', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const removed = ctx.client.services.remove({ name: 'dev', service: 'a/b' });

  expect(removed).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(agent.requests).toStrictEqual([]);
});

test('it refuses an exec-scope add of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  expect(
    exec.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'], user: 'root' } }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(agent.services).toStrictEqual([]);
});

test('it adds, restarts and removes an exec-scope service that runs as the image user', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  await exec.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await exec.services.add({ name: 'dev', service: { name: 'job', argv: ['job'], user: 'dev' } });
  await exec.services.restart({ name: 'dev', service: 'web' });
  await exec.services.remove({ name: 'dev', service: 'job' });

  expect(agent.services.map((service) => service.name)).toStrictEqual(['web']);

  expect(agent.requests.map((request) => request.op)).toStrictEqual([
    'services.list',
    'services.add',
    'services.list',
    'services.add',
    'services.list',
    'services.restart',
    'services.list',
    'services.remove',
  ]);
});

test('it refuses an exec-scope remove of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  expect(exec.services.remove({ name: 'dev', service: 'db' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  expect(agent.services.map((service) => service.name)).toStrictEqual(['db']);
});

test('it refuses an exec-scope restart of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  expect(exec.services.restart({ name: 'dev', service: 'db' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  expect(agent.requests.map((request) => request.op)).not.toContain('services.restart');
});

test('it refuses an exec-scope replace of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  expect(
    exec.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] }, replace: true }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(agent.services.map((service) => service.def?.user)).toStrictEqual(['root']);
});

test('it refuses an exec-scope restart of a service not started yet as FORBIDDEN', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec = ctx.buildClient(token.secret);

  expect(exec.services.restart({ name: 'dev', service: 'late' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it refuses an add on an agent from before the services API as AGENT_OUTDATED', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.9.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: false,
    stack: ctx.stack,
  });

  expect(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it lists the image’s services as root on an agent from before the services API', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.9.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: false,
    stack: ctx.stack,
  });

  agent.services.push(
    create(ServiceStatusSchema, { name: 'dockerd', state: 'running', pid: 212, restarts: 0 }),
  );

  const listed = await ctx.client.services.list({ name: 'dev' });

  expect(listed.services).toStrictEqual([
    {
      name: 'dockerd',
      argv: [],
      cwd: null,
      envKeys: [],
      user: null,
      restart: 'always',
      state: 'running',
      pid: 212,
      restarts: 0,
      lastExit: null,
      source: 'image',
      root: true,
    },
  ]);
});

test('it sends one service’s log, 100 lines by default', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'GET /\nGET /favicon.ico\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web' });
  const events = await Array.fromAsync(stream);

  expect(events).toStrictEqual([
    { type: 'log', service: 'web', text: 'GET /\nGET /favicon.ico\n' },
  ]);

  expect(agent.requests.at(-1)).toStrictEqual(
    create(RequestSchema, { op: 'services.logs', service: 'web', lines: 100, follow: false }),
  );
});

test('it shares 10 000 lines among every service’s log', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] } });

  const stream = await ctx.client.services.logs({ name: 'dev', lines: 100_000 });
  const events = await Array.fromAsync(stream);

  const asked = agent.requests.filter((request) => request.op === 'services.logs');

  expect(events).toStrictEqual([]);
  expect(asked.map((request) => request.lines)).toStrictEqual([5000, 5000]);
});

test('it merges a follow of every service, and closes each when the reader stops', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] } });

  agent.writeLog('web', 'web line\n');
  agent.writeLog('db', 'db line\n');

  const stream = await ctx.client.services.logs({ name: 'dev', follow: true, lines: 5 });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();
  const second = await iterator.next();

  await iterator.return?.();

  await waitFor(() => {
    expect(agent.follows.map((follow) => follow.isClosed)).toStrictEqual([true, true]);
  });

  expect([first.value, second.value]).toIncludeSameMembers([
    { type: 'log', service: 'web', text: 'web line\n' },
    { type: 'log', service: 'db', text: 'db line\n' },
  ]);
});

test('it waits out a sleep in a follow without a wake, and goes on from its cursor', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'one\n');

  const before = await ctx.client.imps.get({ name: 'dev' });
  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const one = await iterator.next();

  await ctx.client.imps.sleep({ name: 'dev' });

  agent.stopFollows();
  agent.writeLog('web', 'two\n');

  const sleeping = await iterator.next();
  const asleep = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await iterator.next();
  const two = await iterator.next();

  agent.writeLog('web', 'three\n');

  const three = await iterator.next();

  await iterator.return?.();

  const resumed = agent.requests.findLast((request) => request.op === 'services.logs');

  expect(one.value).toStrictEqual({ type: 'log', service: 'web', text: 'one\n' });
  expect(sleeping.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(awake.value).toStrictEqual({ type: 'awake' });
  expect(two.value).toStrictEqual({ type: 'log', service: 'web', text: 'two\n' });
  expect(three.value).toStrictEqual({ type: 'log', service: 'web', text: 'three\n' });
  expect(asleep.state).toBe('sleeping');
  expect(asleep.lastActiveAt).toStrictEqual(before.lastActiveAt);
  expect(ctx.fake.wakes).toHaveLength(1);
  expect(resumed?.cursor).toStrictEqual(create(LogCursorSchema, { inode: 7, offset: 4 }));
});

// oRPC's keepalive runs on its own setInterval, so fake timers run 400 s of a
// silent follow, past the 360 s that Bun's fetch waits for a byte.
test('it sends a keepalive comment every 5 s through a silent follow', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  jest.useFakeTimers();

  onTestFinished(() => {
    jest.useRealTimers();
  });

  const response = await ctx.impd.api.app.handle(
    new Request('http://impd.test/rpc/services/logs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'dev', service: 'web', follow: true } }),
    }),
  );

  invariant(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  onTestFinished(() => reader.cancel());

  const opened = { text: '' };

  while (!opened.text.includes('"sleeping"')) {
    const chunk = await reader.read();

    opened.text += chunk.value ?? '';
  }

  jest.advanceTimersByTime(400_000);
  jest.useRealTimers();

  const queued = await readQueuedText(reader, 1000);

  const keepalives = queued.split('\n\n').filter(Boolean);

  expect(keepalives).toHaveLength(80);
  expect(keepalives).toSatisfyAll((frame: string) => frame === ': ');
});

test('it leaves a sleeping imp asleep through a follow', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();

  await iterator.return?.();

  const after = await ctx.client.imps.get({ name: 'dev' });

  expect(first.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(after.state).toBe('sleeping');
  expect(ctx.fake.wakes).toStrictEqual([]);
});

test('it lists a sleeping imp’s services as its sleep recorded them, and wakes nothing', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = await ctx.client.services.list({ name: 'dev' });
  const after = await ctx.client.imps.get({ name: 'dev' });

  expect(asleep.services.map((service) => [service.name, service.state])).toStrictEqual([
    ['web', 'running'],
  ]);

  expect(asleep.recorded).toBe(true);
  expect(after.state).toBe('sleeping');
  expect(ctx.fake.wakes).toStrictEqual([]);
});

test('it refuses a list of a stopped imp’s services as INVALID_STATE', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.imps.stop({ name: 'dev' });

  expect(ctx.client.services.list({ name: 'dev' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it lists no services, and says it recorded none, for a sleep the agent gave no list', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.failing.list = true;

  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = await ctx.client.services.list({ name: 'dev' });

  expect(asleep).toStrictEqual({ services: [], recorded: false });
});

test('it keeps a character that a sleep splits whole in a follow', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', new Uint8Array([0x61, 0xc3]));

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();

  await ctx.client.imps.sleep({ name: 'dev' });

  agent.stopFollows();
  agent.writeLog('web', new Uint8Array([0xa9, 0x0a]));

  const sleeping = await iterator.next();

  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await iterator.next();
  const rest = await iterator.next();

  await iterator.return?.();

  expect(first.value).toStrictEqual({ type: 'log', service: 'web', text: 'a' });
  expect(sleeping.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(awake.value).toStrictEqual({ type: 'awake' });
  expect(rest.value).toStrictEqual({ type: 'log', service: 'web', text: 'é\n' });
});

test('it looks again after the short retry, not the long recheck, while a lifecycle step holds a running imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  const timers = buildStubClock();

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });

  ctx.stack.defer(async () => {
    await stream.return?.();
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);

  agent.stopFollows();

  const pausing = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  timers.firePending();

  const paused = await pausing;

  const resuming = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  const pendingMs = timers.readPendingMs();

  release.resolve();

  await held;

  timers.firePending();

  const resumed = await resuming;

  expect(paused.value).toStrictEqual({ type: 'sleeping', state: 'running' });
  expect(pendingMs).toStrictEqual([500]);
  expect(resumed.value).toStrictEqual({ type: 'awake' });
});

test('it says the imp sleeps when it goes to sleep after a step held it running', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  const timers = buildStubClock();

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });

  ctx.stack.defer(async () => {
    await stream.return?.();
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);

  agent.stopFollows();

  const pausing = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  timers.firePending();

  const paused = await pausing;

  const sleeping = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  release.resolve();

  await held;

  await ctx.client.imps.sleep({ name: 'dev' });

  timers.firePending();

  const asleep = await sleeping;

  expect(paused.value).toStrictEqual({ type: 'sleeping', state: 'running' });
  expect(asleep.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
});

test('it says the imp stopped when it stops after a step held it running', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  const timers = buildStubClock();

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });

  ctx.stack.defer(async () => {
    await stream.return?.();
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);

  agent.stopFollows();

  const pausing = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  timers.firePending();

  const paused = await pausing;

  const stopping = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  release.resolve();

  await held;

  await ctx.client.imps.stop({ name: 'dev' });

  timers.firePending();

  const stopped = await stopping;

  expect(paused.value).toStrictEqual({ type: 'sleeping', state: 'running' });
  expect(stopped.value).toStrictEqual({ type: 'sleeping', state: 'stopped' });
});

test('it goes on with a follow when the wake’s event comes before the wake lets go', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  const unsubscribe = ctx.db.writes.subscribe(() => {
    void updateImpActivity(ctx.db, imp.id, new Date());
  });

  onTestFinished(unsubscribe);

  const timers = buildStubClock();

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });

  ctx.stack.defer(async () => {
    await stream.return?.();
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  agent.stopFollows();

  const pausing = stream.next();

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  timers.firePending();

  const asleep = await pausing;

  const waking = stream.next();

  await ctx.client.imps.wake({ name: 'dev' });

  const pendingMs = timers.readPendingMs();

  timers.firePending();

  const awake = await waking;

  expect(asleep.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(pendingMs).toStrictEqual([500]);
  expect(awake.value).toStrictEqual({ type: 'awake' });
});

test('it ends a follow with the error once its log fails to open five times in a row', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'one\n');

  const timers = buildStubClock();

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });
  const first = await stream.next();

  agent.failing.logs = true;

  agent.stopFollows();

  const reading = readInBackground(stream);

  await waitFor(() => {
    timers.firePending();

    expect(agent.requests.filter((request) => request.op === 'services.logs')).toHaveLength(6);
  });

  const ended = await reading.ended;

  const opens = agent.requests.filter((request) => request.op === 'services.logs');

  expect(first.value).toStrictEqual({ type: 'log', service: 'web', text: 'one\n' });
  expect(ended).toMatchObject({ code: 'INTERNAL' });
  expect(reading.items).toStrictEqual([]);
  expect(opens).toHaveLength(6);
});

test('it lets a list wait out a step that holds a running imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  agent.services.push(
    create(ServiceStatusSchema, { name: 'web', state: 'running', pid: 40, restarts: 0 }),
  );

  const timers = buildStubClock();

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    now: () => 0,
    startTimer: timers.startTimer,
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);
  const listing = api.listServices('dev');

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  release.resolve();

  await held;

  timers.firePending();

  const listed = await listing;

  expect(listed.services.map((service) => service.name)).toStrictEqual(['web']);
});

test('it refuses a list as INVALID_STATE once a step holds a running imp past 10 s', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const timers = buildStubClock();
  const clock = { durationMs: 0 };

  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    now: () => clock.durationMs,
    startTimer: timers.startTimer,
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);

  ctx.stack.defer(async () => {
    release.resolve();

    await held;
  });

  const listing = api.listServices('dev');

  await waitFor(() => {
    expect(timers.readPendingMs()).not.toBeEmpty();
  });

  clock.durationMs = 10_001;

  timers.firePending();

  expect(listing).rejects.toMatchObject({ code: 'INVALID_STATE' });
});

test('it ends a follow when the imp is destroyed', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const reading = readInBackground(stream);

  await waitFor(() => {
    expect(reading.items).not.toBeEmpty();
  });

  await ctx.client.imps.destroy({ name: 'dev' });

  const ended = await reading.ended;

  expect(ended).toBeNull();
  expect(reading.items).toStrictEqual([{ type: 'sleeping', state: 'sleeping' }]);
});

test('it ends a follow with restarting when impd restarts', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.fake.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'one\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const reading = readInBackground(stream);

  await waitFor(() => {
    expect(reading.items).not.toBeEmpty();
  });

  ctx.impd.imps.endLogFollows();

  const ended = await reading.ended;

  expect(ended).toBeNull();

  expect(reading.items).toStrictEqual([
    { type: 'log', service: 'web', text: 'one\n' },
    { type: 'restarting' },
  ]);
});
