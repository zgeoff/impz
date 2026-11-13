import { expect, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { startTestImpd } from '@impz/daemon/test-utils';
import { claimFreePorts } from '@impz/shared/test-utils/claim-free-ports';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = faker.string.alphanumeric(32);

  // impd's own public listener takes a port below the imps' ports
  const publicPort = claimFreePorts(1, {
    pick: () => 10_000 + Math.floor(Math.random() * 10_000),
  }).take();

  const harness = await startTestImpd(stack, {
    rootToken,
    env: { IMP_MCP_PUBLIC_URL: 'https://imp.example', IMP_MCP_PUBLIC_PORT: String(publicPort) },
  });

  const run = (...args: string[]) =>
    runCLIInProcess({
      args: ['oauth', ...args],
      env: { IMP_URL: harness.url, IMP_TOKEN: rootToken },
    });

  return { run };
}

test('it prints an enrollment token and the page to enter it on', async () => {
  const ctx = await setupTest();
  const result = await ctx.run('passkey', 'enroll');

  expect(result).toStrictEqual({
    stdout: expect.stringMatching(
      /^token: \S+\nopen https:\/\/imp\.example\/enroll, enter the token, and enroll a passkey; the token works once\n$/v,
    ),
    stderr: '',
    code: 0,
  });
});

test('it lists no passkey before one is enrolled', async () => {
  const ctx = await setupTest();
  const result = await ctx.run('passkey', 'ls');

  expect(result).toStrictEqual({ stdout: 'ID  CREATED  LAST USED\n', stderr: '', code: 0 });
});

test('it resets the passkeys', async () => {
  const ctx = await setupTest();

  await ctx.run('passkey', 'reset');

  const listed = await ctx.run('passkey', 'ls');

  expect(listed.stdout).toBe('ID  CREATED  LAST USED\n');
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
])('it refuses %s before it calls impd', async (_case, args, message) => {
  const result = await runCLIInProcess({
    args: ['oauth', ...args],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `${message}\n`, code: 2 });
});
