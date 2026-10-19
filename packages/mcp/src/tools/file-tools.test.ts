import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/db/images';
import { findImpByName } from '@impz/daemon/src/db/imps';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  buildStubExecGuest,
  startStubExecAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import invariant from 'tiny-invariant';
import { createImpGuard } from '../imp-guard';
import { createMcpServer } from '../test-utils/create-mcp-server';

// impd's real app on a loopback port for an exec's socket, a root client,
// `stack`, whose releases run before impd stops, and an MCP server whose
// messages land parsed in `sent` through `reply`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the bearer the root client sends
  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  const db = harness.db;
  const dataDir = harness.dataDir;
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // the image every imps.create boots when it names none
  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(db, image);

  const url = harness.url;

  // a short kill grace, so a stopped command's SIGKILL comes soon
  const mcp = createMcpServer({ version: '1.2.3', killGraceMs: 50 });

  // its calls in flight end before impd's app closes
  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    db,
    dataDir,
    stack,
    url,
    rootClient: createImpClient({ url, token: 'root-token' }),
    mcp,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test('it writes a file with the path as one argument of the write script', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_write_file',
        arguments: { name: 'dev', path: '/root/-odd dir/$(x) file.txt', content: 'héllo\n' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { path: '/root/-odd dir/$(x) file.txt', bytes: 7 },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([
    {
      argv: [
        '/bin/sh',
        '-c',

        // the script reads the path as "$1"; it never enters the script text
        expect.not.stringContaining('/root/-odd dir/$(x) file.txt'),
        'sh',
        '/root/-odd dir/$(x) file.txt',
      ],
    },
  ]);

  expect(new TextDecoder().decode(guest.files.get('/root/-odd dir/$(x) file.txt'))).toBe('héllo\n');
});

test('it reads a file with head, asking for one byte past maxBytes', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/root/-odd dir/$(x) file.txt', new TextEncoder().encode('héllo\n'));

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_read_file',
        arguments: { name: 'dev', path: '/root/-odd dir/$(x) file.txt' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          path: '/root/-odd dir/$(x) file.txt',
          encoding: 'utf8',
          bytes: 7,
          content: 'héllo\n',
        },
        isError: false,
      },
    },
  ]);

  // the default maxBytes is 256 KiB
  expect(guest.requests).toMatchObject([
    { argv: ['head', '-c', String(256 * 1024 + 1), '/root/-odd dir/$(x) file.txt'] },
  ]);
});

test('it writes bytes given as base64', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_write_file',
        arguments: { name: 'dev', path: '/bin.dat', content: 'AP/+Cg==', encoding: 'base64' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { path: '/bin.dat', bytes: 4 },
        isError: false,
      },
    },
  ]);

  expect(guest.files.get('/bin.dat')).toStrictEqual(new Uint8Array([0, 255, 254, 10]));
});

test('it refuses to read bytes that are not UTF-8 as utf8', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/bin.dat', new Uint8Array([0, 255, 254, 10]));

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '/bin.dat' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: '/bin.dat is not valid UTF-8; read it with encoding base64\n{\n  "path": "/bin.dat",\n  "bytes": 4\n}',
          },
        ],
        structuredContent: { path: '/bin.dat', bytes: 4 },
        isError: true,
      },
    },
  ]);
});

test('it reads bytes that are not UTF-8 as base64', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/bin.dat', new Uint8Array([0, 255, 254, 10]));

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_read_file',
        arguments: { name: 'dev', path: '/bin.dat', encoding: 'base64' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { path: '/bin.dat', encoding: 'base64', bytes: 4, content: 'AP/+Cg==' },
        isError: false,
      },
    },
  ]);
});

test('it refuses base64 content that does not decode, before anything runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_write_file',
        arguments: { name: 'dev', path: '/x', content: 'not base64!', encoding: 'base64' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'content is not valid base64' }],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it reads a file exactly maxBytes long', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/big', new Uint8Array(100).fill(97));

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '/big', maxBytes: 100 } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { path: '/big', encoding: 'utf8', bytes: 100, content: 'a'.repeat(100) },
        isError: false,
      },
    },
  ]);
});

test('it fails a file larger than maxBytes instead of cutting it', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/big', new Uint8Array(100).fill(97));

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '/big', maxBytes: 99 } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: '/big is larger than maxBytes (99); read a part of it with imp_exec\n{\n  "path": "/big"\n}',
          },
        ],
        structuredContent: { path: '/big' },
        isError: true,
      },
    },
  ]);
});

test("it answers a read that fails in the guest with an isError result holding the command's stderr", async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '/nope' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: 'could not read /nope (exit 1): head: cannot open \'/nope\' for reading: No such file or directory\n{\n  "path": "/nope"\n}',
          },
        ],
        structuredContent: { path: '/nope' },
        isError: true,
      },
    },
  ]);
});

test("it answers a write that fails in the guest with an isError result holding the command's stderr", async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_write_file',
        arguments: { name: 'dev', path: '/readonly/f', content: 'x' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: 'could not write /readonly/f (exit 1): mkdir: can\'t create directory \'/readonly\': Read-only file system\n{\n  "path": "/readonly/f"\n}',
          },
        ],
        structuredContent: { path: '/readonly/f' },
        isError: true,
      },
    },
  ]);
});

test('it refuses a relative path before anything runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '-rf' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('must be an absolute path') as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test.each([
  ['a sleeping', 'sleep'],
  ['a stopped', 'stop'],
] as const)('it reads a file of %s imp', async (_state, transition) => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/etc/hostname', new TextEncoder().encode('box\n'));

  await ctx.rootClient.imps[transition]({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '/etc/hostname' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { path: '/etc/hostname', encoding: 'utf8', bytes: 4, content: 'box\n' },
        isError: false,
      },
    },
  ]);
});

test.each([
  ['a sleeping', 'sleep'],
  ['a stopped', 'stop'],
] as const)('it leaves %s imp running after a read', async (_state, transition) => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  guest.files.set('/etc/hostname', new TextEncoder().encode('box\n'));

  await ctx.rootClient.imps[transition]({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_read_file', arguments: { name: 'dev', path: '/etc/hostname' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const imp = await ctx.rootClient.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});
