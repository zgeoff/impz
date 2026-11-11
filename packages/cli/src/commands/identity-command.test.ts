import { expect, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import { startTestImpd } from '@impz/daemon/test-utils';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, {
    rootToken,
    env: { IMP_IDENTITY_ISSUER: 'imp-host-a' },
    frozenClockMs: Date.UTC(2026, 11, 1, 3, 0, 0),
  });

  const sendRequest = (request: Request) => harness.impd.api.app.handle(request);

  return {
    rootToken,
    url: harness.url,
    client: createImpClient({ url: 'http://impd.test', token: rootToken, fetch: sendRequest }),
  };
}

test('it stores a secret with identity, and lists it with the mark', async () => {
  const ctx = await setupTest();

  const added = await runCLIInProcess({
    args: [
      'secret',
      'add',
      'tasks',
      '--kind',
      'static',
      '--hosts',
      'tasks.imp.internal',
      '--upstream',
      'http://192.0.2.10:18090',
      '--identity',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-token\n',
  });

  const listed = await runCLIInProcess({
    args: ['secret', 'ls'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(added.code).toBe(0);
  expect(listed.stdout).toContain('tasks.imp.internal -> http://192.0.2.10:18090 (identity)');
});

test('it stores identity on each rule of a secret with several hosts', async () => {
  const ctx = await setupTest();

  await runCLIInProcess({
    args: [
      'secret',
      'add',
      'tasks',
      '--kind',
      'static',
      '--hosts',
      'a.imp.internal,b.imp.internal',
      '--identity',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-token\n',
  });

  const [secret] = await ctx.client.secrets.list();

  expect(secret?.rules.map((rule) => rule.identity)).toStrictEqual([true, true]);
});

test('it refuses to turn identity on for a stored secret without a rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'tasks',
    kind: 'static',
    value: 'v1',
    rules: [{ host: 'tasks.imp.internal', header: 'authorization', scheme: 'bearer' }],
  });

  const result = await runCLIInProcess({
    args: [
      'secret',
      'add',
      'tasks',
      '--kind',
      'static',
      '--hosts',
      'tasks.imp.internal',
      '--identity',
      '--replace',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-token\n',
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('a rebind (--rebind) drops its grants');
});

test('it turns identity on for a stored secret with --rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'tasks',
    kind: 'static',
    value: 'v1',
    rules: [{ host: 'tasks.imp.internal', header: 'authorization', scheme: 'bearer' }],
  });

  const result = await runCLIInProcess({
    args: [
      'secret',
      'add',
      'tasks',
      '--kind',
      'static',
      '--hosts',
      'tasks.imp.internal',
      '--identity',
      '--replace',
      '--rebind',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    stdin: 'fake-token\n',
  });

  const [secret] = await ctx.client.secrets.list();

  expect(result.code).toBe(0);
  expect(secret?.rules[0]?.identity).toBeTrue();
});

test('it prints the key set as a JSON document with the issuer', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['identity', 'jwks'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(JSON.parse(result.stdout)).toStrictEqual({
    issuer: 'imp-host-a',
    keys: [
      {
        kty: 'EC',
        crv: 'P-256',
        x: expect.any(String) as unknown,
        y: expect.any(String) as unknown,
        kid: expect.any(String) as unknown,
        alg: 'ES256',
        use: 'sig',
      },
    ],
    retire: [],
  });
});

test('it stages a key for a time and prints both keys with the retire entry', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['identity', 'key', 'stage', '--at', '2026-12-01T04:00Z'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const printed = JSON.parse(result.stdout) as { keys: unknown[]; retire: unknown[] };

  expect(result.code).toBe(0);
  expect(printed.keys).toHaveLength(2);

  expect(printed.retire).toStrictEqual([
    { kid: expect.any(String) as unknown, at: Date.UTC(2026, 11, 1, 4, 0, 0) / 1000 },
  ]);
});

test('it refuses a switch time that is not a time', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['identity', 'key', 'stage', '--at', 'tomorrow'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --at: not a time: tomorrow (try 2026-12-01T03:00Z)\n',
    code: 2,
  });
});

test('it shows the issuer in impz info', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['info'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.stdout).toContain('identity    imp-host-a');
});
