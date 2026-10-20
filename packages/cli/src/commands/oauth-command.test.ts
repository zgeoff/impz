import { expect, mock, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { ApprovalCodeSchema } from '@impz/api';
import { createImpClient } from '@impz/client';
import { claimFreePorts, createPendingSignIn, startTestImpd } from '@impz/daemon/testing';
import * as z from 'zod';
import { UsageError } from '../cli/errors';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { runApprove } from './oauth-command';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root bearer; each test reads it back for its client
  const rootToken = faker.string.alphanumeric(32);

  // the port impd's own public listener takes, below the imps' ports
  const publicPort = claimFreePorts(1, {
    pick: () => 10_000 + Math.floor(Math.random() * 10_000),
  }).take();

  // impd's clock stays where a test sets it
  const harness = await startTestImpd(stack, {
    rootToken,
    frozenClockMs: Date.now(),
    env: {
      // the public MCP route a sign-in is for, as tests name it
      IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171',
      IMP_MCP_PUBLIC_PORT: String(publicPort),
    },
  });

  const impd = harness.impd;

  // a call's body as oRPC sends it: the input under `json`
  const RpcBodySchema = z.looseObject({ json: z.unknown() });

  // each call a client makes: its procedure and its input as oRPC sends it
  const calls: { readonly path: string; readonly input: unknown }[] = [];

  return {
    rootToken,
    now: harness.now,
    advance: harness.advance,
    calls,

    // the public route's OAuth paths, with impd's 404 for any other
    handleRoute: async (request: Request) => {
      const answered = await impd.oauth.handle(request);

      return answered ?? new Response('not found', { status: 404 });
    },

    // a client of impd's API for the token with this secret
    connect: (token: string) =>
      createImpClient({
        url: 'http://impd.test',
        token,
        fetch: async (request) => {
          const body: unknown = await request.clone().json();

          calls.push({
            path: new URL(request.url).pathname.slice('/rpc/'.length),
            input: RpcBodySchema.parse(body).json,
          });

          return impd.api.app.handle(request);
        },
      }),
  };
}

test('it refuses without a terminal or --yes before it calls impd', () => {
  const client = createImpClient({ url: 'http://127.0.0.1:1' });

  const prompt = {
    isTerminal: false,
    confirm: mock(() => Promise.resolve(true)),
    show: mock<(line: string) => void>(),
  };

  expect(
    runApprove(
      client,
      { code: 'ABCDEFGH', scope: 'exec', imps: undefined, isConfirmed: false },
      prompt,
    ),
  ).rejects.toThrowWithMessage(
    UsageError,
    'impz oauth approve asks before it approves, and stdin is not a terminal; pass --yes to approve without asking',
  );
});

test('it shows the sign-in and approves nothing when the answer at a terminal is no', async () => {
  const ctx = await setupTest();

  const root = ctx.connect(ctx.rootToken);

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'approver', scope: 'manage' });

  // the sign-in starts at a known time
  ctx.advance(Date.UTC(2026, 0, 1) - ctx.now());

  const started = await createPendingSignIn({
    respond: ctx.handleRoute,
    origin: 'http://127.0.0.1:7171',
    clientID: added.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'exec',
  });

  const code = ApprovalCodeSchema.parse(started.code);
  const show = mock<(line: string) => void>();
  const confirm = mock(() => Promise.resolve(false));
  const approver = ctx.connect(made.secret);

  const approving = runApprove(
    approver,
    { code, scope: 'exec', imps: ['dev-*'], isConfirmed: false },
    { isTerminal: true, confirm, show },
  );

  expect(approving).rejects.toThrowWithMessage(Error, 'not approved; nothing changed');
  expect(confirm).toHaveBeenCalledExactlyOnceWith('Approve this sign-in? [y/N] ');
  expect(ctx.calls.filter((call) => call.path === 'oauth/approvals/approve')).toBeEmpty();

  expect(show.mock.calls).toStrictEqual([
    [
      [
        'client:       conn',
        'returns to:   https://client.example/callback',
        'asks for:     up to exec',
        'started:      2026-01-01T00:00:00.000Z',
        'ends:         2026-01-01T00:10:00.000Z',
      ].join('\n'),
    ],
    ['it gets:      exec on dev-*'],
  ]);
});

test('it approves what it showed when the answer at a terminal is yes', async () => {
  const ctx = await setupTest();

  const root = ctx.connect(ctx.rootToken);

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'approver', scope: 'manage' });

  const started = await createPendingSignIn({
    respond: ctx.handleRoute,
    origin: 'http://127.0.0.1:7171',
    clientID: added.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'exec',
  });

  const code = ApprovalCodeSchema.parse(started.code);
  const show = mock<(line: string) => void>();
  const approver = ctx.connect(made.secret);

  await runApprove(
    approver,
    { code, scope: 'exec', imps: ['dev-*'], isConfirmed: false },
    { isTerminal: true, confirm: () => Promise.resolve(true), show },
  );

  expect(show).toHaveBeenLastCalledWith(
    'impz: approved: conn gets exec on dev-*; press Continue on the sign-in page',
  );

  expect(ctx.calls.filter((call) => call.path === 'oauth/approvals/approve')).toStrictEqual([
    { path: 'oauth/approvals/approve', input: { code, scope: 'exec', imps: ['dev-*'] } },
  ]);

  expect(approver.oauth.approvals.approve({ code, scope: 'exec' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test.each([
  ['without', false],
  ['with', true],
])('it approves without asking for --yes %s a terminal', async (_case, isTerminal) => {
  const ctx = await setupTest();

  const root = ctx.connect(ctx.rootToken);

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'approver', scope: 'manage' });

  const started = await createPendingSignIn({
    respond: ctx.handleRoute,
    origin: 'http://127.0.0.1:7171',
    clientID: added.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'exec',
  });

  const code = ApprovalCodeSchema.parse(started.code);
  const confirm = mock(() => Promise.resolve(false));
  const show = mock<(line: string) => void>();

  await runApprove(
    ctx.connect(made.secret),
    { code, scope: 'exec', imps: undefined, isConfirmed: true },
    { isTerminal, confirm, show },
  );

  expect(confirm).not.toHaveBeenCalled();

  expect(show).toHaveBeenLastCalledWith(
    "impz: approved: conn gets exec on the token's imps; press Continue on the sign-in page",
  );
});

test('it refuses an approval of more than a read token holds', async () => {
  const ctx = await setupTest();

  const root = ctx.connect(ctx.rootToken);

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'reader', scope: 'read' });

  const started = await createPendingSignIn({
    respond: ctx.handleRoute,
    origin: 'http://127.0.0.1:7171',
    clientID: added.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'exec',
  });

  const code = ApprovalCodeSchema.parse(started.code);

  expect(
    runApprove(
      ctx.connect(made.secret),
      { code, scope: 'exec', imps: undefined, isConfirmed: true },
      { isTerminal: false, confirm: () => Promise.resolve(true), show: () => {} },
    ),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token reader has read, so it may approve that or less',
  });
});

test.each([
  [
    'an http redirect URI off loopback',
    ['client', 'add', 'conn', '--redirect-uri', 'http://client.example/cb'],
    'impz: --redirect-uri takes https URLs, or http on a loopback host, with no fragment; not http://client.example/cb',
  ],
  [
    'a redirect URI with a fragment',
    ['client', 'set', 'conn', '--redirect-uri', 'https://client.example/cb#x'],
    'impz: --redirect-uri takes https URLs, or http on a loopback host, with no fragment; not https://client.example/cb#x',
  ],
  [
    'a code that is not a sign-in code',
    ['approve', 'ABCD-EFG0'],
    'impz: ABCD-EFG0 is not a sign-in code; it looks like ABCD-EFGH',
  ],
  [
    'an unknown scope',
    ['approve', 'ABCD-EFGH', '--scope', 'admin'],
    'impz: --scope must be one of read, exec, manage',
  ],
  [
    'an imp pattern with an inner star',
    ['approve', 'ABCD-EFGH', '--imps', 'd*v'],
    'impz: --imps takes imp names, or a name prefix and a trailing *, such as dev-*; not d*v',
  ],
])('it refuses %s before it calls impd', async (_case, args, message) => {
  const result = await runCLIInProcess({
    args: ['oauth', ...args],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `${message}\n`, code: 2 });
});
