import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { readMcpAnswer } from '@impz/mcp/test-utils/read-mcp-answer';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildStubTailscale } from '../../../testing/network/build-stub-tailscale';
import { claimFreePorts } from '../../../testing/platform/claim-free-ports';
import { startTestImpd } from '../../../testing/start-test-impd';
import { TEST_TOKEN } from '../../../testing/test-token';
import { buildStubExecGuest } from '../../../testing/vm/build-stub-exec-guest';
import { startStubExecAgent } from '../../../testing/vm/start-stub-exec-agent';
import { runWhois } from '../../identity/auth/tailnet-identity';
import { PEER_HEADER } from '../../network/proxy/forwarded-peers';
import { startWakeProxy } from '../../network/proxy/wake-proxy';
import { listApiCalls } from '../../platform/db/api-audit';
import { createImage } from '../../platform/db/images';
import { readImpByName } from '../../platform/db/imps';
import { buildImagePaths, buildImpPaths } from '../../vm/storage/data-layout';

interface SetupOptions {
  readonly tailscale: Pick<ReturnType<typeof buildStubTailscale>, 'run'>;
  readonly idleTimeoutS?: number;
}

async function setupTest(options: SetupOptions) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: {
      whois: (address) => runWhois(address, options.tailscale.run),
      ...(options.idleTimeoutS !== undefined && { apiIdleTimeoutS: options.idleTimeoutS }),
    },
  });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  return Object.assign(harness, {
    client: createImpClient({ url: harness.url, token: TEST_TOKEN }),
    stack,
  });
}

test('it names a nameless create under the one prefix its token may touch', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { image: 'ubuntu' } },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: false,
      structuredContent: {
        imp: { name: expect.stringMatching(/^agent-[a-z0-9]{8}$/u) as unknown },
      },
    },
  });
});

test('it audits a tool call as the token that made it', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'agent-a', image: 'ubuntu' } },
    }),
  });

  const calls = await listApiCalls(ctx.db, 'agent-a', 10, null);

  expect(calls).toPartiallyContain({ procedure: 'imps.create', actorName: 'agent', outcome: 'ok' });
});

test('it runs a command in an imp its token may touch', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'agent-a' });

  const record = await readImpByName(ctx.db, 'agent-a');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'agent-a', command: 'echo hi' } },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { exitCode: 0, stdout: 'hi\n' } },
  });
});

test('it refuses a create outside the patterns of its token', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'other', image: 'ubuntu' } },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^FORBIDDEN: /u) as unknown }],
    },
  });
});

test('it lists only the read tools to a read token', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: {
      tools: [
        { name: 'imp_list' },
        { name: 'imp_url' },
        { name: 'imp_image_list' },
        { name: 'imp_checkpoint_list' },
      ],
    },
  });
});

test('it lists the imps to a read token', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'box' });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { imps: [{ name: 'box' }] } },
  });
});

test.each([
  ['imp_exec', { name: 'box', command: 'echo hi' }],
  ['imp_write_file', { name: 'box', path: '/x', content: 'x' }],
  ['imp_destroy', { name: 'box' }],
])('it refuses %s to a read token before it reaches the guest', async (tool, args) => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await readImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^FORBIDDEN: /u) as unknown }],
    },
  });

  expect(guest.requests).toStrictEqual([]);
});

test('it refuses a fork to a token that may grant secrets', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'agent-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    grantable: ['gh'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'agent-a', name: 'agent-b' } },
    }),
  });

  const body = await readMcpAnswer(response);
  const imps = await ctx.client.imps.list();

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^FORBIDDEN: /u) as unknown }],
    },
  });

  expect(imps.map((imp) => imp.name)).toStrictEqual(['agent-a']);
});

test('it asks a token with two patterns to name the imp it creates', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const made = await ctx.client.tokens.create({
    name: 'two',
    scope: 'manage',
    imps: ['a-*', 'b-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { image: 'ubuntu' } },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [
        {
          type: 'text',
          text: 'GUARD: this token may touch only imps matching a-*, b-*, so give the new imp a name that matches',
        },
      ],
      isError: true,
    },
  });
});

test('it refuses a session to a caller other than the one that opened it', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const first = await ctx.client.tokens.create({ name: 'first', scope: 'read' });
  const second = await ctx.client.tokens.create({ name: 'second', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${first.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${second.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(response.status).toBe(404);
});

test('it ends the streamed call and running command of a token that is removed', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await readImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const call = fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
    }),
  });

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await ctx.client.tokens.delete({ name: 'agent' });

  const response = await call;
  const text = await response.text();

  await waitFor(() => {
    invariant(guest.closed[0] !== undefined);
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');

  expect(
    text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line): unknown => JSON.parse(line.slice('data: '.length))),
  ).toStrictEqual([]);

  expect(guest.closed).toStrictEqual(['sleepy']);
});

test('it refuses the session of a removed token with 401', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  await ctx.client.tokens.delete({ name: 'agent' });

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(response.status).toBe(401);
});

test('it refuses a caller with no token and no handed-over address with 401', async () => {
  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale: buildStubTailscale(),
  });

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  expect(response.status).toBe(401);
});

test('it serves a tailnet identity the wake proxy hands over the imps its rule allows', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale,
  });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'atc', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { imps: [{ name: 'dev-a' }] } },
  });
});

test.each([
  ['an Origin on another site', { origin: 'http://evil.example' }, 403],
  ['a cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site' }, 403],
  [
    'a same-site Sec-Fetch-Site',
    { 'sec-fetch-site': 'same-site', origin: 'http://impd.example' },
    403,
  ],
  [
    'a same-origin Sec-Fetch-Site whatever the Origin',
    { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example' },
    400,
  ],
  ['its own host as the Origin, over another scheme', { origin: 'https://impd.example' }, 400],
])('it answers a page that sends %s with %d', async (_label, headers, status) => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      host: 'impd.example',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
  });

  expect(response.status).toBe(status);
});

test('it answers a tool call through the wake proxy’s API route', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'box' });

  const proxy = startWakeProxy({
    config: {
      ...ctx.config,
      apiPort: Number(new URL(ctx.url).port),
      proxyPort: claimFreePorts(1).take(),
    },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: ctx.impd.peers,
  });

  ctx.stack.defer(() => proxy.stop());

  const front = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => front.stop(true));

  const via = `http://127.0.0.1:${String(front.port)}`;

  const opened = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const response = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
  });

  const body = await readMcpAnswer(response);

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { imps: [{ name: 'box' }] } },
  });
});

test('it answers a long JSON tool call through the wake proxy', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const done = Promise.withResolvers<void>();
  const guest = buildStubExecGuest({ wait: () => done.promise });

  ctx.stack.defer(() => {
    done.resolve();
  });

  await ctx.client.imps.create({ name: 'box' });

  const record = await readImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const proxy = startWakeProxy({
    config: {
      ...ctx.config,
      apiPort: Number(new URL(ctx.url).port),
      proxyPort: claimFreePorts(1).take(),
    },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: ctx.impd.peers,
  });

  ctx.stack.defer(() => proxy.stop());

  const front = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => front.stop(true));

  const via = `http://127.0.0.1:${String(front.port)}`;

  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

  const answers: (string | null)[] = [];

  const sendRequest = async (url: string | URL, init: RequestInit | undefined) => {
    const response = await fetch(url, init);

    answers.push(response.headers.get('content-type'));

    return response;
  };

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${via}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
      fetch: sendRequest,
    }),
  );

  ctx.stack.defer(() => client.close());

  const call = client.callTool({
    name: 'imp_exec',
    arguments: { name: 'box', command: 'wait 1' },
  });

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  done.resolve();

  const result = await call;

  expect(answers).toSatisfyAll((type: string | null) => type === 'application/json');

  expect(result).toMatchObject({
    isError: false,
    structuredContent: { exitCode: 0, stdout: 'waited\n' },
  });
});

test('it keeps a call answered as server-sent events open through the wake proxy past the idle timeout that ends an unprotected stream', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale(), idleTimeoutS: 1 });

  const done = Promise.withResolvers<void>();
  const guest = buildStubExecGuest({ wait: () => done.promise });

  ctx.stack.defer(() => {
    done.resolve();
  });

  await ctx.client.imps.create({ name: 'box' });

  const record = await readImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const proxy = startWakeProxy({
    config: {
      ...ctx.config,
      apiPort: Number(new URL(ctx.url).port),
      proxyPort: claimFreePorts(1).take(),
    },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: ctx.impd.peers,
  });

  ctx.stack.defer(() => proxy.stop());

  const front = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => front.stop(true));

  const via = `http://127.0.0.1:${String(front.port)}`;

  const opened = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session !== null);

  const call = fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'wait 1' } },
    }),
  });

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  const control = await fetch(`${ctx.url}/rpc/events/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });

  const [expired] = await Promise.allSettled([control.text()]);

  done.resolve();

  const response = await call;
  const text = await response.text();

  expect(expired).toMatchObject({ status: 'rejected', reason: { code: 'ECONNRESET' } });
  expect(response.headers.get('content-type')).toBe('text/event-stream');

  expect(
    text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line): unknown => JSON.parse(line.slice('data: '.length))),
  ).toMatchObject([
    {
      id: 1,
      result: { isError: false, structuredContent: { exitCode: 0, stdout: 'waited\n' } },
    },
  ]);
}, 20_000);
