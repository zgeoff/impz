import { expect, onTestFinished, test } from 'bun:test';
import type { ApiCall, ImpEvent, Scope } from '@impz/api';
import { createImpClient } from '@impz/client';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import * as z from 'zod';
import { buildStubTailscale } from '../../testing/network/build-stub-tailscale';
import { buildMockNewAuditEntry } from '../../testing/platform/build-mock-new-audit-entry';
import { startTestImpd } from '../../testing/start-test-impd';
import { tryExecSocket, tryTunnelSocket } from '../../testing/surface/try-impd-sockets';
import { TEST_TOKEN } from '../../testing/test-token';
import { buildStubExecGuest } from '../../testing/vm/build-stub-exec-guest';
import { startStubExecAgent } from '../../testing/vm/start-stub-exec-agent';
import { listApiCalls } from '../db/api-audit';
import { writeAuditEntry } from '../db/broker-audit';
import { PEER_HEADER } from '../proxy/forwarded-peers';
import { buildImpPaths } from '../storage/data-layout';
import { PROCEDURE_ACCESS } from './access-policy';
import { runWhois } from './tailnet-identity';

interface SetupOptions {
  // the `tailscale` CLI that impd's whois runs; its peers are the test's
  readonly tailscale: Pick<ReturnType<typeof buildStubTailscale>, 'run'>;
}

// impd's real app on stub VMs, reached in process and on a loopback port
// for its sockets, with a root client for the scenario
async function setupTest(options: SetupOptions) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { whois: (address) => runWhois(address, options.tailscale.run) },
  });

  // the image every imps.create boots when it names none
  await harness.createTestImage('ubuntu');

  const sendToImpd = (request: Request) => harness.impd.api.app.handle(request);

  return {
    db: harness.db,
    dataDir: harness.dataDir,
    impd: harness.impd,
    stack,
    port: new URL(harness.url).port,
    sendToImpd,
    client: createImpClient({ url: 'http://impd.test', token: TEST_TOKEN, fetch: sendToImpd }),
  };
}

// The access check runs before input validation, so each procedure is called
// with an empty input and a refusal is FORBIDDEN, not BAD_REQUEST.
test('it refuses every procedure to a token whose scope is below what it needs', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const scopes: readonly Scope[] = ['read', 'exec', 'manage'];

  const clients = await Promise.all(
    scopes.map(async (scope) => {
      const made = await ctx.client.tokens.create({ name: `scope-${scope}`, scope });

      return createImpClient({
        url: 'http://impd.test',
        token: made.secret,
        fetch: ctx.sendToImpd,
      });
    }),
  );

  // each procedure with each scope below the one it needs
  const cases = Object.entries(PROCEDURE_ACCESS).flatMap(([path, access]) =>
    scopes.slice(0, scopes.indexOf(access.scope)).map((scope) => ({ path, scope })),
  );

  const outcomes = await Promise.allSettled(
    cases.map(async (entry) => {
      const procedure = z
        .function()
        .parse(
          entry.path
            .split('.')
            .reduce<unknown>(
              (node, key) => Reflect.get(new Object(node), key),
              clients[scopes.indexOf(entry.scope)],
            ),
        );

      const answer: unknown = await Reflect.apply(procedure, undefined, [{}]);

      return answer;
    }),
  );

  expect(cases.length).toBeGreaterThan(30);

  expect(cases.map((entry, index) => [entry.path, entry.scope, outcomes[index]])).toMatchObject(
    cases.map((entry) => [
      entry.path,
      entry.scope,
      { status: 'rejected', reason: { code: 'FORBIDDEN' } },
    ]),
  );
});

test('it refuses every host-wide procedure to a manage token limited to some imps', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const made = await ctx.client.tokens.create({
    name: 'limited',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const hostPaths = Object.entries(PROCEDURE_ACCESS)
    .filter(([, access]) => access.on === 'host')
    .map(([path]) => path);

  const outcomes = await Promise.allSettled(
    hostPaths.map(async (path) => {
      const procedure = z
        .function()
        .parse(
          path
            .split('.')
            .reduce<unknown>((node, key) => Reflect.get(new Object(node), key), limited),
        );

      const answer: unknown = await Reflect.apply(procedure, undefined, [{}]);

      return answer;
    }),
  );

  expect(hostPaths).toContain('secrets.add');

  expect(hostPaths.map((path, index) => [path, outcomes[index]])).toMatchObject(
    hostPaths.map((path) => [path, { status: 'rejected', reason: { code: 'FORBIDDEN' } }]),
  );
});

test('it answers a create with the token and a secret in the token format', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  const made: unknown = await ctx.client.tokens.create({
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });

  expect(made).toStrictEqual({
    secret: expect.stringMatching(/^imp_[\w-]{16}\.[\w-]{43}$/u) as unknown,
    token: {
      name: 'ci',
      scope: 'exec',
      imps: ['dev-*'],
      sshKeys: [],
      grantable: [],
      imageRefPrefix: null,
      createdAt: expect.any(Date) as unknown,
    },
  });
});

test('it lists a token without its secret', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });
  const listed = await ctx.client.tokens.list();

  expect(listed).toStrictEqual([made.token]);
  expect(JSON.stringify(listed)).not.toContain(made.secret.split('.')[1]);
});

test('it tells a token who it is', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const ci = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const identity = await ci.tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
    imageRefPrefix: null,
  });
});

test('it refuses a token with the name of another with a conflict', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  expect(ctx.client.tokens.create({ name: 'ci', scope: 'read' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a token named root with a conflict', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  expect(ctx.client.tokens.create({ name: 'root', scope: 'read' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a removed token', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const ci = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await ctx.client.tokens.delete({ name: 'ci' });

  expect(ci.system.info()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

test('it lists no token once the only one is removed', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });
  await ctx.client.tokens.delete({ name: 'ci' });

  const left = await ctx.client.tokens.list();

  expect(left).toStrictEqual([]);
});

test('it lists a token limited to dev-* only its imps', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const imps = await dev.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev-a']);
});

test('it lists a token limited to dev-* a secret’s grants on its imps only', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'prod', secret: 'gh' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const secrets = await dev.secrets.list();

  expect(secrets.map((secret) => secret.imps)).toStrictEqual([['dev-a']]);
});

test('it refuses a token limited to dev-* a stop of another imp', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.stop({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* a create that leaves the name to impd', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.create({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* a create of an imp outside its pattern', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.create({ name: 'prod-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* a grant of a host secret', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it refuses a token limited to dev-* another imp’s audit events', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.audit.list({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* another imp’s API calls', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.audit.calls({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* another imp’s refused broker requests', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.audit.refused({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it lists a token limited to dev-* only the refused broker requests of its imps', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const devA = await ctx.client.imps.create({ name: 'dev-a' });
  const prod = await ctx.client.imps.create({ name: 'prod' });

  await writeAuditEntry(
    ctx.db,
    buildMockNewAuditEntry({
      impId: devA.id,
      impName: 'dev-a',
      secretName: null,
      path: null,
      status: 403,
      reason: 'egress-policy',
    }),
  );

  await writeAuditEntry(
    ctx.db,
    buildMockNewAuditEntry({
      impId: prod.id,
      impName: 'prod',
      secretName: null,
      path: null,
      status: 403,
      reason: 'egress-policy',
    }),
  );

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const seen = await dev.audit.refused({});

  expect(seen.map((entry) => entry.imp)).toStrictEqual(['dev-a']);
});

test('it lists a token limited to dev-* only the API calls on its imps', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await dev.imps.stop({ name: 'dev-a' });

  // each audit row lands after its answer; root's calls include host-wide
  // ones, on no imp
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, null, 100, null);

    expect(listed).toPartiallyContain({ procedure: 'imps.stop', actorName: 'dev' });

    return listed;
  });

  const seen = await dev.audit.calls({});

  expect(calls).toSatisfyAny((call: Readonly<ApiCall>) => call.imp === undefined);
  expect(seen).toSatisfyAll((call: Readonly<ApiCall>) => call.imp?.startsWith('dev-') === true);

  expect(seen).toPartiallyContain({
    procedure: 'imps.stop',
    outcome: 'ok',
    actor: 'token',
    actorName: 'dev',
    imp: 'dev-a',
  });
});

test('it refuses a token limited to dev-* an imp from another imp’s template', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.images.add({ imp: 'prod', name: 'prod-tpl' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.create({ name: 'dev-copy', image: 'prod-tpl' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it lets a token limited to dev-* make an imp from its own imp’s template', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-src' });
  await ctx.client.images.add({ imp: 'dev-src', name: 'dev-tpl' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const allowed = await dev.imps.create({ name: 'dev-copy', image: 'dev-tpl' });

  expect(allowed.image).toBe('dev-tpl');
});

test('it names in each template’s audit row the imp whose disk it copied', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.imps.create({ name: 'dev-src' });
  await ctx.client.images.add({ imp: 'prod', name: 'prod-tpl' });
  await ctx.client.images.add({ imp: 'dev-src', name: 'dev-tpl' });

  // each audit row lands after its answer
  const adds = await waitFor(async () => {
    const calls = await listApiCalls(ctx.db, null, 100, null);

    const found = calls.filter((call) => call.procedure === 'images.add');

    expect(found).toHaveLength(2);

    return found;
  });

  expect(adds.map((call) => call.imp)).toIncludeSameMembers(['dev-src', 'prod']);
});

test('it streams a limited token the events of its imps only', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'read', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const stream = await dev.events.stream(undefined, { signal: controller.signal });

  const seen: ImpEvent[] = [];

  // reads until the stream ends, when the test aborts it
  const reading = Array.fromAsync(stream, (event) => {
    seen.push(event);

    return event;
  });

  await ctx.client.imps.stop({ name: 'prod' });
  await ctx.client.imps.stop({ name: 'dev-a' });

  // the stream's last event for this test: dev-a's stop, after prod's
  await waitFor(() => {
    expect(seen).toSatisfyAny(
      (event: Readonly<ImpEvent>) =>
        event.ev === 'ImpChanged' && event.imp.name === 'dev-a' && event.imp.state === 'stopped',
    );
  });

  controller.abort();

  await reading;

  expect(seen[0]).toMatchObject({ ev: 'ImpAdded', imp: { name: 'dev-a' } });

  expect(seen).toSatisfyAll(
    (event: Readonly<ImpEvent>) => !JSON.stringify(event).includes('"prod"'),
  );
});

test('it refuses an exec socket to a read token', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const outcome = await tryExecSocket(ctx.port, '', 'dev-a', {
    authorization: `Bearer ${made.secret}`,
  });

  expect(JSON.parse(outcome)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses an exec socket to an exec token for dev-* on another imp', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const outcome = await tryExecSocket(ctx.port, '', 'prod', {
    authorization: `Bearer ${made.secret}`,
  });

  expect(JSON.parse(outcome)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses a tunnel to an exec token for dev-* on another imp', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const outcome = await tryTunnelSocket(
    ctx.port,
    '',
    { authorization: `Bearer ${made.secret}` },
    'prod',
  );

  expect(JSON.parse(outcome)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses an exec ticket to a read token', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev-a' });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(reader.exec.ticket({ name: 'dev-a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses an exec ticket to an exec token for dev-* on another imp', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.exec.ticket({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it opens nothing for a ticket once its token is removed', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const ci = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const issued = await ci.exec.ticket({ name: 'dev' });

  await ctx.client.tokens.delete({ name: 'ci' });

  const outcome = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  expect(outcome).toBe('rejected');
});

test('it closes a token’s open sockets when the token is removed', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/tunnel`, {
    headers: { authorization: `Bearer ${made.secret}` },
  });

  onTestFinished(() => {
    socket.close();
  });

  const opened = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('open', () => {
    opened.resolve(undefined);
  });

  socket.addEventListener('close', closed.resolve);

  await opened.promise;

  await ctx.client.tokens.delete({ name: 'ci' });

  const event = await closed.promise;

  // policy violation
  expect(event.code).toBe(1008);
});

// A removal that lands after the token passed its check but before the
// socket opened: the socket must close all the same.
test('it closes at once a socket that opens after its token is revoked', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const tokenId = /^imp_(?<id>[^.]+)\./v.exec(made.secret)?.groups?.['id'];

  invariant(tokenId !== undefined);

  ctx.impd.revocations.revoke(tokenId);

  const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/tunnel`, {
    headers: { authorization: `Bearer ${made.secret}` },
  });

  onTestFinished(() => {
    socket.close();
  });

  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('close', closed.resolve);

  const event = await closed.promise;

  // policy violation
  expect(event.code).toBe(1008);
});

test('it refuses a token limited to no imps at all', async () => {
  const ctx = await setupTest({ tailscale: buildStubTailscale() });

  expect(ctx.client.tokens.create({ name: 'none', scope: 'read', imps: [] })).rejects.toMatchObject(
    { code: 'BAD_REQUEST' },
  );
});

test('it refuses a loopback client that names a tailnet address itself', async () => {
  // alice's laptop is the one tailnet peer
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  // alice may exec on dev-* imps
  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale,
  });

  const response = await fetch(`http://127.0.0.1:${ctx.port}/rpc/tokens/whoami`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PEER_HEADER]: '100.101.102.103',
      'x-forwarded-for': '100.101.102.103',
    },
  });

  expect(response.status).toBe(401);
});

test('it serves a tailnet identity through a peer handle the wake proxy registered', async () => {
  // alice's laptop is the one tailnet peer
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  // alice may exec on dev-* imps
  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale,
  });

  const response = await fetch(`http://127.0.0.1:${ctx.port}/rpc/tokens/whoami`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(200);

  expect(body).toMatchObject({
    json: { kind: 'tailnet', name: 'alice@example.com' },
  });
});

test('it refuses a tailnet identity an exec socket from a page on an imp’s port', async () => {
  // alice's laptop is the one tailnet peer
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  // alice may exec on dev-* imps
  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale,
  });

  await ctx.client.imps.create({ name: 'dev-a' });

  const outcome = await tryExecSocket(ctx.port, '', 'dev-a', {
    [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    origin: 'http://127.0.0.1:20000',
  });

  expect(outcome).toBe('rejected');
});

test('it refuses a tailnet identity a tunnel from a page on an imp’s port', async () => {
  // alice's laptop is the one tailnet peer
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  // alice may exec on dev-* imps
  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale,
  });

  await ctx.client.imps.create({ name: 'dev-a' });

  const outcome = await tryTunnelSocket(
    ctx.port,
    '',
    {
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
      origin: 'http://127.0.0.1:20000',
    },
    'dev-a',
  );

  expect(outcome).toBe('rejected');
});

test('it opens an exec socket for a tailnet identity from impd’s own page', async () => {
  // alice's laptop is the one tailnet peer
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  // alice may exec on dev-* imps
  updateEnv(
    'IMP_TAILNET_IDENTITIES',
    '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
  );

  const ctx = await setupTest({
    tailscale,
  });

  const created = await ctx.client.imps.create({ name: 'dev-a' });

  // the imp's agent, which runs the exec; it closes before impd stops
  const agent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, created.id).vsockSocket,
    buildStubExecGuest(),
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const outcome = await tryExecSocket(ctx.port, '', 'dev-a', {
    [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    origin: `http://127.0.0.1:${ctx.port}`,
  });

  expect(JSON.parse(outcome)).toMatchObject({ type: 'started' });
});
