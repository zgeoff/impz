import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpClient } from '@impz/client';
import { startStubImpdRelease, startTestImpd } from '@impz/daemon/testing';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startStubInfoFaultImpd } from '../test-utils/start-stub-info-fault-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  const sendRequest = (request: Request) => harness.impd.api.app.handle(request);

  return {
    stack,
    sendRequest,
    client: createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: sendRequest }),
    url: harness.url,
  };
}

test('it refuses a scope a token cannot have', async () => {
  const result = await runCLIInProcess({
    args: ['token', 'new', 'ci', '--scope', 'root'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --scope must be one of read, exec, manage\n',
    code: 2,
  });
});

test('it refuses an imp pattern that is not an imp name', async () => {
  const result = await runCLIInProcess({
    args: ['token', 'new', 'ci', '--scope', 'exec', '--imps', 'Dev*'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: --imps takes imp names with * for any run of characters, such as dev-*; not Dev*\n',
    code: 2,
  });
});

test('it refuses a private key where a .pub file belongs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const privateKey = join(directory, 'id_ed25519');

  await writeFile(privateKey, '-----BEGIN OPENSSH PRIVATE KEY-----\n');

  const result = await runCLIInProcess({
    args: ['token', 'key', 'add', 'ci', privateKey],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `impz: ${privateKey} is a private key; give its .pub file\n`,
    code: 2,
  });
});

test('it refuses a .pub file that holds no key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const empty = join(directory, 'empty.pub');

  await writeFile(empty, '# nothing\n');

  const result = await runCLIInProcess({
    args: ['token', 'key', 'add', 'ci', empty],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `impz: ${empty} holds no key\n`, code: 2 });
});

test('it refuses an --ssh-key file that is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const missing = join(directory, 'missing.pub');

  const result = await runCLIInProcess({
    args: ['token', 'new', 'ci', '--scope', 'exec', '--ssh-key', missing],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `impz: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
    code: 2,
  });
});

test.each([
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--grantable', 'gh'],
    'impz: --grantable needs --scope manage and --imps\n',
  ],
  [
    ['token', 'new', 'agent', '--scope', 'exec', '--imps', 'agent-*', '--grantable', 'gh'],
    'impz: --grantable needs --scope manage and --imps\n',
  ],
  [
    [
      'token',
      'new',
      'agent',
      '--scope',
      'manage',
      '--imps',
      'agent-*',
      '--grantable',
      'Not A Name',
    ],
    'impz: --grantable takes secret names, such as gh,npm; not Not A Name\n',
  ],
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', '', '--grantable', 'gh'],
    'impz: --imps takes imp names with * for any run of characters, such as dev-*; not \n',
  ],
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', ' , ', '--grantable', 'gh'],
    'impz: --imps takes imp names with * for any run of characters, such as dev-*; not  , \n',
  ],
  [
    ['token', 'set', 'agent', '--grantable', 'Not A Name'],
    'impz: --grantable takes secret names, such as gh,npm; not Not A Name\n',
  ],
  [
    ['token', 'new', 'nixie', '--scope', 'manage', '--image-ref-prefix', 'ghcr.io/zgeoff/nixie-'],
    'impz: --image-ref-prefix needs --scope manage and --imps\n',
  ],
  [
    [
      'token',
      'new',
      'nixie',
      '--scope',
      'manage',
      '--imps',
      'nixie-*',
      '--image-ref-prefix',
      'zgeoff/nixie-',
    ],
    'impz: --image-ref-prefix takes a registry host and the start of a path, such as ghcr.io/org/app-; not zgeoff/nixie-\n',
  ],
  [['token', 'set', 'agent'], 'impz: give --grantable, --image-ref-prefix or both\n'],
])('it refuses %p before any call to impd', async (args, stderr) => {
  const result = await runCLIInProcess({
    args,
    env: { IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test.each([
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    'grantableTokens',
    'is older than 0.27.0 and would drop --grantable and make the token without that limit',
  ],
  [
    ['token', 'set', 'agent', '--grantable', 'gh'],
    'tokenUpdate',
    'is older than 0.34.0 and would not know tokens.update',
  ],
  [
    [
      'token',
      'new',
      'nixie',
      '--scope',
      'manage',
      '--imps',
      'nixie-*',
      '--image-ref-prefix',
      'ghcr.io/zgeoff/nixie-',
    ],
    'tokenImageAdd',
    'has no token image adds and would drop --image-ref-prefix and make a token that adds no image',
  ],
  [
    ['token', 'set', 'nixie', '--image-ref-prefix', 'ghcr.io/zgeoff/nixie-'],
    'tokenImageAdd',
    'has no token image adds and would not change the image ref prefix',
  ],
])(
  'it makes no call past the feature check for %p on an impd from before %s',
  async (args, feature, reason) => {
    const ctx = await setupTest();

    const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, { withoutFeatures: [feature] });

    const result = await runCLIInProcess({
      args,
      env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
    });

    expect(result).toStrictEqual({
      stdout: '',
      stderr: `impz: this impd ${reason}; nothing was changed. Upgrade impd, or use an older imp CLI\n`,
      code: 1,
    });

    expect(older.calls).toStrictEqual(['system/features']);
  },
);

test('it creates no token on an impd from before SystemInfo.features', async () => {
  const ctx = await setupTest();

  const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, { isWithoutFeatureList: true });

  const result = await runCLIInProcess({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
  });

  expect(result.code).toBe(1);
  expect(older.calls).toStrictEqual(['system/features']);
});

test('it creates no token when the feature check’s connection drops', async () => {
  const ctx = await setupTest();

  const impd = startStubInfoFaultImpd(ctx.stack, ctx.sendRequest);

  const result = await runCLIInProcess({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { IMP_URL: impd.url, IMP_TOKEN: 'root-token' },
  });

  const tokens = await ctx.client.tokens.list();

  // an older Bun leaves the error's code out of a fetch error's message
  expect(result).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(
      /^impz: (?:ECONNRESET: )?The socket connection was closed unexpectedly\. For more information, pass `verbose: true` in the second argument to fetch\(\)\n$/v,
    ),
    code: 1,
  });

  expect(impd.calls).toStrictEqual(['system/features']);
  expect(tokens.map((token) => token.name)).not.toContain('agent');
});

test('it creates a grantable token on an impd with the feature', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });

  const result = await runCLIInProcess({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const tokens: unknown = await ctx.client.tokens.list();

  const received: unknown = result;

  expect(received).toStrictEqual({
    stdout: expect.stringMatching(/^imp_\S+\n$/u) as unknown,
    stderr: 'impz: token agent made; impd shows its secret only this once\n',
    code: 0,
  });

  expect(tokens).toStrictEqual([
    {
      name: 'agent',
      scope: 'manage',
      imps: ['agent-*'],
      sshKeys: [],
      grantable: ['gh'],
      imageRefPrefix: null,
      createdAt: expect.toBeValidDate() as unknown,
    },
  ]);
});

test('it sends the grantable list on token set to an impd with tokens.update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });
  await ctx.client.tokens.create({ name: 'agent', scope: 'manage', imps: ['agent-*'] });

  const result = await runCLIInProcess({
    args: ['token', 'set', 'agent', '--grantable', 'gh', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    sshKeys: [],
    grantable: ['gh'],
    imageRefPrefix: null,
    createdAt: expect.any(String) as unknown,
  });
});

test('it clears the grantable list on token set with an empty --grantable', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    grantable: ['gh'],
  });

  const result = await runCLIInProcess({
    args: ['token', 'set', 'agent', '--grantable', '', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    sshKeys: [],
    grantable: [],
    imageRefPrefix: null,
    createdAt: expect.any(String) as unknown,
  });
});

test('it creates a token with an image ref prefix and shows it in token ls', async () => {
  const ctx = await setupTest();

  await runCLIInProcess({
    args: [
      'token',
      'new',
      'nixie',
      '--scope',
      'manage',
      '--imps',
      'nixie-*',
      '--image-ref-prefix',
      'ghcr.io/zgeoff/nixie-',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const listed = await runCLIInProcess({
    args: ['token', 'ls'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const lines: unknown = listed.stdout.split('\n').map((line) => line.trimEnd());

  expect(lines).toStrictEqual([
    'NAME   SCOPE   IMPS     GRANTABLE  IMAGE REF PREFIX       SSH KEYS  CREATED',
    expect.stringMatching(
      /^nixie {2}manage {2}nixie-\* {2}- {10}ghcr\.io\/zgeoff\/nixie- {2}0 {9}\S+$/u,
    ) as unknown,
    '',
  ]);
});

test('it gives a token an image ref prefix on token set', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'nixie', scope: 'manage', imps: ['nixie-*'] });

  const result = await runCLIInProcess({
    args: ['token', 'set', 'nixie', '--image-ref-prefix', 'ghcr.io/zgeoff/nixie-', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    sshKeys: [],
    grantable: [],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
    createdAt: expect.any(String) as unknown,
  });
});

test('it takes a token’s image ref prefix away on token set with an empty --image-ref-prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  await runCLIInProcess({
    args: ['token', 'set', 'nixie', '--image-ref-prefix', ''],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const tokens = await ctx.client.tokens.list();

  expect(tokens.map((token) => token.imageRefPrefix)).toStrictEqual([null]);
});

test('it names a token it cannot find on token key ls', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['token', 'key', 'ls', 'ci'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'impz: no token named ci\n', code: 2 });
});
