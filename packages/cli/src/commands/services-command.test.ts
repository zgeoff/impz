import { expect, mock, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import { RequestSchema } from '@impz/daemon/src/agent-client/agent-protocol';
import { encodeAgentMessage } from '@impz/daemon/src/agent-client/encode-agent-message';
import { sendServicesAdd } from '@impz/daemon/src/agent-client/service-requests';
import { createImage } from '@impz/daemon/src/db/images';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  startStubServiceAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import { UsageError } from '../cli/errors';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { buildServiceDef, createLogPrinter, formatLogEvent } from './services-command';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root bearer; each test reads it back for the CLI
  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  const dataDir = harness.dataDir;

  // each boot reports an agent with the services API (0.10.0)
  harness.fake.agent.version = '0.10.0';

  const sendClientRequest = (request: Request) => harness.impd.api.app.handle(request);

  const client = createImpClient({
    url: 'http://impd.test',
    token: rootToken,
    fetch: sendClientRequest,
  });

  // the image a test's imps boot from, with a rootfs where its digest names
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  return {
    // a test defers what must stop before impd, such as a guest's agent
    stack,
    rootToken,
    dataDir,
    client,
    url: harness.url,
  };
}

test('#buildServiceDef runs --cmd through the shell', () => {
  expect(buildServiceDef('web', { cmd: 'node server.js', argv: [] })).toStrictEqual({
    name: 'web',
    argv: ['/bin/sh', '-c', 'node server.js'],
  });
});

test('#buildServiceDef takes the words after -- as the argv and the flags for the rest', () => {
  const def = buildServiceDef('web', {
    argv: ['busybox', 'httpd', '-f'],
    env: ['PORT=3000', 'MODE=dev'],
    cwd: '/srv',
    user: 'www-data',
    restart: 'on-failure',
  });

  expect(def).toStrictEqual({
    name: 'web',
    argv: ['busybox', 'httpd', '-f'],
    env: ['PORT=3000', 'MODE=dev'],
    cwd: '/srv',
    user: 'www-data',
    restart: 'on-failure',
  });
});

test.each([
  ['no command', { argv: [] }, 'give the command once: --cmd "…" or after --'],
  [
    'a command given twice',
    { cmd: 'a', argv: ['b'] },
    'give the command once: --cmd "…" or after --',
  ],
  ['an --env with no =', { argv: ['x'], env: ['NOEQUALS'] }, '--env NOEQUALS: want KEY=VALUE'],
  [
    'an --env key that starts with a digit',
    { argv: ['x'], env: ['1X=2'] },
    '--env 1X=2: want KEY=VALUE',
  ],
])('#buildServiceDef refuses %s as a usage error', (_case, args, message) => {
  expect(() => buildServiceDef('web', args)).toThrowWithMessage(UsageError, message);
});

test('#createLogPrinter gives each whole line its service’s name with a prefix', () => {
  const write = mock<(text: string) => void>();
  const printer = createLogPrinter(true, write);

  printer.print({ type: 'log', service: 'web', text: 'GET /\nGET /a' });
  printer.print({ type: 'log', service: 'db', text: 'ready\n' });
  printer.print({ type: 'log', service: 'web', text: 'bc\n' });
  printer.print({ type: 'log', service: 'db', text: 'tail with no end' });
  printer.flush();

  expect(write.mock.calls).toStrictEqual([
    ['web | GET /\n'],
    ['db | ready\n'],
    ['web | GET /abc\n'],
    ['db | tail with no end\n'],
  ]);
});

test('#createLogPrinter writes a line longer than 64 KiB in pieces, each with the prefix', () => {
  const write = mock<(text: string) => void>();
  const printer = createLogPrinter(true, write);

  printer.print({ type: 'log', service: 'web', text: 'x'.repeat(65_536 * 2 + 3) });
  printer.flush();

  expect(write.mock.calls).toStrictEqual([
    [`web | ${'x'.repeat(65_536)}\n`],
    [`web | ${'x'.repeat(65_536)}\n`],
    ['web | xxx\n'],
  ]);
});

test('#createLogPrinter writes text as it comes without a prefix', () => {
  const write = mock<(text: string) => void>();
  const printer = createLogPrinter(false, write);

  printer.print({ type: 'log', service: 'web', text: 'GET' });
  printer.print({ type: 'log', service: 'web', text: ' /\n' });
  printer.flush();

  expect(write.mock.calls).toStrictEqual([['GET'], [' /\n']]);
});

test.each([
  [
    'sleeping',
    { type: 'sleeping', state: 'sleeping' },
    'box is sleeping; waiting for it to run (a follow does not wake it)',
  ],
  ['awake', { type: 'awake' }, 'box runs again'],
  ['restarting', { type: 'restarting' }, 'impd is restarting; the follow ends'],
] as const)('#formatLogEvent says what a %s event means for a follow', (_case, event, line) => {
  expect(formatLogEvent('box', event)).toBe(line);
});

test('#serviceCommand sends the definition to the guest with --env given more than once', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const result = await runCLIInProcess({
    args: [
      'service',
      'add',
      'box',
      'web',
      '--env',
      'A=1',
      '--env=B=2',
      '--replace',
      '--cmd',
      'httpd -f',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });

  expect(agent.requests.map((request) => encodeAgentMessage(RequestSchema, request))).toStrictEqual(
    [
      {
        op: 'services.add',
        def: { name: 'web', argv: ['/bin/sh', '-c', 'httpd -f'], env: ['A=1', 'B=2'] },
        replace: true,
      },
    ],
  );
});

test('#serviceCommand adds the service and then sets the imp’s HTTP port for --http-port', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const result = await runCLIInProcess({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd -f -p 8081', '--http-port', '8081'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const updated = await ctx.client.imps.get({ name: 'box' });

  // impd writes its audit rows after it answers
  const calls = await waitFor(async () => {
    const listed = await ctx.client.audit.calls({ name: 'box' });

    expect(listed).toHaveLength(2);

    return listed;
  });

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });
  expect(updated.httpPort).toBe(8081);

  expect(agent.requests.map((request) => encodeAgentMessage(RequestSchema, request))).toStrictEqual(
    [
      {
        op: 'services.add',
        def: { name: 'web', argv: ['/bin/sh', '-c', 'httpd -f -p 8081'] },
      },
    ],
  );

  // newest first: the port set came after the imp's create
  expect(calls.map((call) => [call.procedure, call.outcome])).toStrictEqual([
    ['imps.update', 'ok'],
    ['imps.create', 'ok'],
  ]);
});

test('#serviceCommand sets no HTTP port when the guest refuses the add', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const vsockPath = buildImpPaths(ctx.dataDir, imp.id).vsockSocket;

  const agent = await startStubServiceAgent(vsockPath, { knowsServices: true, stack: ctx.stack });

  // the guest has a service web already, so an add without --replace is refused
  await sendServicesAdd(vsockPath, { name: 'web', argv: ['httpd'] }, false);

  const result = await runCLIInProcess({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd -f -p 8081', '--http-port', '8081'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const updated = await ctx.client.imps.get({ name: 'box' });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: CONFLICT: service web already exists\n',
    code: 1,
  });

  expect(imp.httpPort).not.toBe(8081);
  expect(updated.httpPort).toBe(imp.httpPort);

  expect(agent.requests.map((request) => encodeAgentMessage(RequestSchema, request))).toStrictEqual(
    [
      { op: 'services.add', def: { name: 'web', argv: ['httpd'] } },
      { op: 'services.add', def: { name: 'web', argv: ['/bin/sh', '-c', 'httpd -f -p 8081'] } },
    ],
  );
});

test('#serviceCommand says the service runs and how to set the port when an exec token may not set it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });
  const made = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const result = await runCLIInProcess({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd', '--http-port', '8081'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: made.secret },
  });

  const updated = await ctx.client.imps.get({ name: 'box' });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: service web was added and runs, but the HTTP port was not set: setting the HTTP port needs a token with manage. Run `impz set box --http-port 8081` to set it.\n',
    code: 1,
  });

  // the list of what the guest runs, then the add
  expect(agent.requests.map((request) => encodeAgentMessage(RequestSchema, request))).toStrictEqual(
    [
      { op: 'services.list' },
      { op: 'services.add', def: { name: 'web', argv: ['/bin/sh', '-c', 'httpd'] } },
    ],
  );

  expect(imp.httpPort).not.toBe(8081);
  expect(updated.httpPort).toBe(imp.httpPort);
});

test('#serviceCommand refuses a bad --http-port before it calls impd', async () => {
  const result = await runCLIInProcess({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd', '--http-port', '70000'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --http-port must be at most 65535, not 70000\n',
    code: 2,
  });
});

test('#serviceCommand refuses an unknown --restart before it calls impd', async () => {
  const result = await runCLIInProcess({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd', '--restart', 'sometimes'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --restart must be one of always, on-failure, never\n',
    code: 2,
  });
});

test('#serviceCommand says when a sleeping imp’s last sleep recorded no list', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });
  await ctx.client.imps.sleep({ name: 'box' });

  const result = await runCLIInProcess({
    args: ['service', 'ls', 'box', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '[]\n',
    stderr: 'box is sleeping, and its last sleep recorded no services list\n',
    code: 0,
  });
});

test('#logsCommand refuses a line count that is not a number before it calls impd', async () => {
  const result = await runCLIInProcess({
    args: ['logs', 'box', '-n', 'ten'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --lines must be a whole number, not ten\n',
    code: 2,
  });
});
