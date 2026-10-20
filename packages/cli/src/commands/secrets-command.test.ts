import { expect, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/db/images';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubBrokerTokenEndpoint,
  startStubImpdRelease,
  startTestImpd,
} from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startStubInfoFaultImpd } from '../test-utils/start-stub-info-fault-impd';

// impd's real app, listening on a loopback port for the spawned CLI, and an
// in-process client of it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root bearer; each test reads it back for the CLI
  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  const sendRequest = (request: Request) => harness.impd.api.app.handle(request);

  return {
    stack,
    dataDir: harness.dataDir,
    db: harness.db,
    sendRequest,
    rootToken,
    client: createImpClient({ url: 'http://impd.test', token: rootToken, fetch: sendRequest }),
    url: harness.url,
  };
}

test('it refuses a secret value given as a flag, which only stdin may carry', async () => {
  const result = await runCLIInProcess({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--value', 'ghp_x'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: unknown flag --value for secret add (see --help)\n',
    code: 2,
  });
});

test.each([
  [
    'an unknown kind',
    ['--kind', 'gitlab'],
    'impz: --kind must be one of github, anthropic, npm, custom, oauth',
  ],
  ['a custom kind without hosts', ['--kind', 'custom'], 'impz: --kind custom needs --hosts'],
  [
    'hosts on a github kind',
    ['--kind', 'github', '--hosts', 'api.github.com'],
    'impz: --hosts, --header, --scheme and --user are for --kind custom and --kind oauth',
  ],
  ['an oauth kind without hosts', ['--kind', 'oauth'], 'impz: --kind oauth needs --hosts'],
  [
    'an oauth kind without a token URL and client ID',
    ['--kind', 'oauth', '--hosts', 'api.example.com'],
    'impz: --kind oauth needs --token-url and --client-id',
  ],
  [
    'an http token URL',
    [
      '--kind',
      'oauth',
      '--hosts',
      'api.example.com',
      '--token-url',
      'http://a.example.com/t',
      '--client-id',
      'c',
    ],
    'impz: Invalid URL',
  ],
  [
    'an unknown token format',
    [
      '--kind',
      'oauth',
      '--hosts',
      'api.example.com',
      '--token-url',
      'https://a.example.com/t',
      '--client-id',
      'c',
      '--token-format',
      'xml',
    ],
    'impz: Invalid option: expected one of "json"|"form"',
  ],
  [
    'oauth flags on a custom kind',
    ['--kind', 'custom', '--hosts', 'api.example.com', '--client-id', 'c'],
    'impz: --token-url, --client-id and --token-format are for --kind oauth',
  ],
  [
    'an address as a host',
    ['--kind', 'custom', '--hosts', '10.0.0.1'],
    'impz: must be a lowercase hostname such as api.example.com',
  ],
  [
    'an unknown scheme',
    ['--kind', 'custom', '--hosts', 'api.example.com', '--scheme', 'digest'],
    'impz: Invalid option: expected one of "bearer"|"basic"|"raw"',
  ],
])('it refuses %s before it asks for a value', async (_case, flags, message) => {
  const result = await runCLIInProcess({
    args: ['secret', 'add', 'api', ...flags],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `${message}\n`, code: 2 });
});

test('it refuses an audit limit outside 1 to 1000', async () => {
  const result = await runCLIInProcess({
    args: ['audit', '--limit', '0'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --limit must be at least 1, not 0\n',
    code: 2,
  });
});

// impd's address is a closed port: a call would fail to connect, not refuse
test.each([
  [['secret', 'add', 'gh', '--kind', 'github', '--rebind'], 'impz: --rebind needs --replace\n'],
  [
    [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'a.example.com,b.example.com',
      '--upstream',
      'http://172.17.0.1:18081',
    ],
    'impz: --upstream needs exactly one host in --hosts\n',
  ],
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--upstream', 'http://172.17.0.1:18081'],
    'impz: --upstream is for --kind custom\n',
  ],
  [
    [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'op-connect.imp.internal',
      '--upstream',
      'http://172.17.0.1:18081/x',
    ],
    'impz: must be an origin with no path\n',
  ],
])('it refuses %p before any call to impd', async (args, stderr) => {
  const result = await runCLIInProcess({
    args,
    env: { IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'root-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test.each([
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    'secretRebind',
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
  ],
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace', '--rebind'],
    'secretRebind',
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
  ],
  [
    [
      'secret',
      'add',
      'codex',
      '--kind',
      'oauth',
      '--hosts',
      'chatgpt.com',
      '--token-url',
      'https://auth.example.com/oauth/token',
      '--client-id',
      'fake-client',
      '--token-format',
      'json',
    ],
    'oauthSecrets',
    'has no oauth secrets and would refuse the oauth kind',
  ],
  [
    ['secret', 'refresh', 'codex'],
    'oauthSecrets',
    'has no oauth secrets and would not know the command',
  ],
  [
    [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'op-connect.imp.internal',
      '--upstream',
      'http://172.17.0.1:18081',
    ],
    'secretUpstream',
    'has no secret upstreams and would send the credential to the host itself',
  ],
])(
  'it makes no call past the feature check for %p on an impd from before %s',
  async (args, feature, reason) => {
    const ctx = await setupTest();

    const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, { withoutFeatures: [feature] });

    const result = await runCLIInProcess({
      args,
      env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
      stdin: 'fake-secret-value\n',
    });

    expect(result).toStrictEqual({
      stdout: '',
      stderr: `impz: this impd ${reason}; nothing was changed. Upgrade impd, or use an older imp CLI\n`,
      code: 1,
    });

    expect(older.calls).toStrictEqual(['system/features']);
  },
);

test('it replaces no secret on an impd from before SystemInfo.features', async () => {
  const ctx = await setupTest();

  const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, { isWithoutFeatureList: true });

  const result = await runCLIInProcess({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(1);
  expect(older.calls).toStrictEqual(['system/features']);
});

test('it replaces no secret when the feature check’s connection drops', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-old-value' });

  const impd = startStubInfoFaultImpd(ctx.stack, ctx.sendRequest);

  const result = await runCLIInProcess({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { IMP_URL: impd.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()\n',
    code: 1,
  });

  expect(impd.calls).toStrictEqual(['system/features']);
});

test('it replaces a secret on an impd with the feature', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-old-value' });

  const result = await runCLIInProcess({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME  KIND    STATE  HOSTS                                         IMPS',
      'gh    github  -      github.com,api.github.com,uploads.github.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it adds a plain secret without a feature check, even on an impd from before SystemInfo.features', async () => {
  const ctx = await setupTest();

  const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, { isWithoutFeatureList: true });

  const result = await runCLIInProcess({
    args: ['secret', 'add', 'gh', '--kind', 'github'],
    env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(0);
  expect(older.calls).toStrictEqual(['secrets/add']);
});

test('it says until when an added oauth secret’s access token is valid', async () => {
  const ctx = await setupTest();

  // an access token whose JWT expiry is 2030-01-01T00:00:00Z
  const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: 1_893_456_000 })).toString('base64url')}.sig`;
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh', { access_token: accessToken, refresh_token: 'fake-refresh-1' });

  const result = await runCLIInProcess({
    args: [
      'secret',
      'add',
      'codex',
      '--kind',
      'oauth',
      '--hosts',
      'chatgpt.com',
      '--token-url',
      'https://auth.example.com/oauth/token',
      '--client-id',
      'fake-client',
      '--token-format',
      'json',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-refresh\n',
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND   STATE                                 HOSTS        IMPS',
      'codex  oauth  ready until 2030-01-01T00:00:00.000Z  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: 'impz: codex signed in, access token valid until 2030-01-01T00:00:00.000Z\n',
    code: 0,
  });
});

test('it says why an added oauth secret failed its sign-in', async () => {
  const ctx = await setupTest();

  // the endpoint has issued nothing for this refresh token, so it refuses it
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  const result = await runCLIInProcess({
    args: [
      'secret',
      'add',
      'codex',
      '--kind',
      'oauth',
      '--hosts',
      'chatgpt.com',
      '--token-url',
      'https://auth.example.com/oauth/token',
      '--client-id',
      'fake-client',
      '--token-format',
      'json',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-refresh\n',
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND   STATE                        HOSTS        IMPS',
      'codex  oauth  needs_login (invalid_grant)  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: 'impz: codex is needs_login: invalid_grant\n',
    code: 0,
  });
});

test('it prints a refreshed oauth secret that is ready', async () => {
  const ctx = await setupTest();

  // an access token whose JWT expiry is 2030-01-01T00:00:00Z, for the add's
  // sign-in and then the refresh
  const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: 1_893_456_000 })).toString('base64url')}.sig`;
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh', { access_token: accessToken, refresh_token: 'fake-refresh-1' });
  endpoint.issue('fake-refresh-1', { access_token: accessToken, refresh_token: 'fake-refresh-2' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });

  const result = await runCLIInProcess({
    args: ['secret', 'refresh', 'codex'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND   STATE                                 HOSTS        IMPS',
      'codex  oauth  ready until 2030-01-01T00:00:00.000Z  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it exits 1 for a refreshed oauth secret that is not ready', async () => {
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'temporarily_unavailable' }, { status: 503 }),
    ),
  );

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });

  const result = await runCLIInProcess({
    args: ['secret', 'refresh', 'codex', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'codex',
    kind: 'oauth',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: expect.any(String) as unknown,
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
      status: 'pending',
      expiresAt: null,
      refreshedAt: null,
      error: 'HTTP 503',
      idClaims: null,
    },
  });

  expect(result.stderr).toBe('impz: codex is pending: HTTP 503\n');
  expect(result.code).toBe(1);
});

test('it shows a state column on secret ls, with a dash for other kinds', async () => {
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'refresh_token_reused' }, { status: 400 }),
    ),
  );

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });

  const result = await runCLIInProcess({
    args: ['secret', 'ls'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND    STATE                               HOSTS                                         IMPS',
      'codex  oauth   needs_login (refresh_token_reused)  chatgpt.com                                   -',
      'gh     github  -                                   github.com,api.github.com,uploads.github.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it sends a secret upstream in the rule to an impd that knows it', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'op-connect.imp.internal',
      '--upstream',
      'http://172.17.0.1:18081',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-token\n',
  });

  const secrets: unknown = await ctx.client.secrets.list();

  expect(result.code).toBe(0);

  expect(secrets).toStrictEqual([
    {
      name: 'op-connect',
      kind: 'custom',
      rules: [
        {
          host: 'op-connect.imp.internal',
          header: 'authorization',
          scheme: 'bearer',
          upstream: 'http://172.17.0.1:18081',
        },
      ],
      imps: [],
      createdAt: expect.toBeValidDate() as unknown,
    },
  ]);
});

test('it stores nothing when stdin gives an empty value', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['secret', 'add', 'gh', '--kind', 'github'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: '\n',
  });

  const secrets = await ctx.client.secrets.list();

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: no value given; nothing stored\n',
    code: 2,
  });

  expect(secrets).toBeEmpty();
});

test('it lists the refused broker requests as JSON, none on a new impd', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['audit', '--kind', 'refused', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({ stdout: '[]\n', stderr: '', code: 0 });
});

test('it lists no refused broker requests from an impd without them', async () => {
  const ctx = await setupTest();

  const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, {
    withoutFeatures: ['brokerRefusals'],
  });

  const result = await runCLIInProcess({
    args: ['audit', '--kind', 'refused'],
    env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no audit of refused broker requests and would not know the call; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/features']);
});

test('it grants a secret for the methods and paths given', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const result = await runCLIInProcess({
    args: ['grant', 'dev', 'gh', '--methods', 'GET,HEAD', '--paths', '/repos/*/*/issues,/user'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const grants = await ctx.client.grants.details({ name: 'dev' });

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });

  expect(grants).toStrictEqual([
    { secret: 'gh', filter: { methods: ['GET', 'HEAD'], paths: ['/repos/*/*/issues', '/user'] } },
  ]);
});

test('it grants a secret for the whole host without --methods or --paths', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const result = await runCLIInProcess({
    args: ['grant', 'dev', 'gh'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const grants = await ctx.client.grants.details({ name: 'dev' });

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });
  expect(grants).toStrictEqual([{ secret: 'gh', filter: null }]);
});

test('it refuses a path pattern that is not one, before it calls impd', async () => {
  const result = await runCLIInProcess({
    args: ['grant', 'dev', 'gh', '--paths', '/v1/**/x'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: --paths: must be a path such as /v1/messages, with * for one segment and a last /** for the rest\n',
    code: 2,
  });
});

test('it makes no filtered grant on an impd from before grant filters', async () => {
  const ctx = await setupTest();

  const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, {
    withoutFeatures: ['grantFilters'],
  });

  const result = await runCLIInProcess({
    args: ['grant', 'dev', 'gh', '--methods', 'GET'],
    env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no grant filters and would grant the whole host; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/features']);
});

test('it lists each grant with the methods and paths it covers', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'npm_value' });

  await ctx.client.grants.add({
    name: 'dev',
    secret: 'gh',
    filter: { methods: ['GET'], paths: ['/repos/**'] },
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'npm' });

  const result = await runCLIInProcess({
    args: ['grants', 'dev', '--filters'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: ['SECRET  METHODS  PATHS', 'gh      GET      /repos/**', 'npm     *        *', ''].join(
      '\n',
    ),
    stderr: '',
    code: 0,
  });
});

test('it refuses an audit kind other than broker, refused or api', async () => {
  const result = await runCLIInProcess({
    args: ['audit', '--kind', 'tokens'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --kind must be one of broker, refused, api\n',
    code: 2,
  });
});
