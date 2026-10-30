import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  buildStubExecGuest,
  createImage,
  readVmIdentity,
  startStubExecAgent,
  startTestImpd,
  writeVmIdentity,
} from '@impz/daemon/testing';
import { probeUpdateReadOnly } from '@impz/test-utils/probe-update-read-only';
import { updateReadOnly } from '@impz/test-utils/update-read-only';
import invariant from 'tiny-invariant';
import { readHostConfig, resolveConfigPath, writeHostConfig } from '../config/host-store';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-login-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const env = { HOME: directory, XDG_CONFIG_HOME: directory };
  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  return {
    env,
    rootToken,
    db: harness.db,
    dataDir: harness.dataDir,
    stack,
    url: harness.url,
  };
}

test('#login saves the host as current when impd accepts the token', async () => {
  const ctx = await setupTest();

  const login = await runCLIInProcess({
    args: ['login', ctx.url, '--name', 'home'],
    env: ctx.env,
    stdin: `${ctx.rootToken}\n`,
  });

  expect(login).toStrictEqual({
    stdout: `logged in to ${ctx.url} as home, now the current host\n`,
    stderr: '',
    code: 0,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'home',
    hosts: { home: { url: ctx.url, token: ctx.rootToken } },
  });
});

test('#login refuses a URL that is not http(s) and saves nothing', async () => {
  const ctx = await setupTest();

  const login = await runCLIInProcess({
    args: ['login', 'ftp://imp.example'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: 'impz: not an http(s) URL: ftp://imp.example\n',
    code: 2,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('#hosts lists the saved hosts without their tokens', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'login-token' } },
  });

  const listed = await runCLIInProcess({ args: ['hosts'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '   NAME  URL                   TOKEN\n*  home  https://home.example  saved\n',
    stderr: '',
    code: 0,
  });
});

test('#login saves nothing when impd refuses the token', async () => {
  const ctx = await setupTest();
  const login = await runCLIInProcess({ args: ['login', ctx.url], env: ctx.env, stdin: 'wrong\n' });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: `impz: ${ctx.url} refused the token; nothing saved\n`,
    code: 1,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('#login saves nothing when the token is empty', async () => {
  const ctx = await setupTest();

  const login = await runCLIInProcess({
    args: ['login', 'http://127.0.0.1:1'],
    env: ctx.env,
    stdin: '\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: 'impz: no token given; nothing saved\n',
    code: 2,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('#login saves nothing when impd is out of reach', async () => {
  const ctx = await setupTest();

  const login: unknown = await runCLIInProcess({
    args: ['login', 'http://127.0.0.1:1'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(
      /^impz: cannot check the token with http:\/\/127\.0\.0\.1:1: .+; nothing saved\n$/u,
    ) as unknown,
    code: 1,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('#login saves without asking impd and warns of plain http under --no-verify', async () => {
  const ctx = await setupTest();

  const login = await runCLIInProcess({
    args: ['login', 'http://imp.example:7070', '--no-verify'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: 'logged in to http://imp.example:7070 as imp, now the current host\n',
    stderr:
      'impz: warning: http://imp.example:7070 is plain http; the token crosses the network unencrypted\n',
    code: 0,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'imp',
    hosts: { imp: { url: 'http://imp.example:7070', token: 'login-token' } },
  });
});

test('#login leaves a damaged config.json as it was and asks impd nothing', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: {} });

  await writeFile(resolveConfigPath(ctx.env), '{ damaged', { mode: 0o600 });

  const login: unknown = await runCLIInProcess({
    args: ['login', 'http://127.0.0.1:1'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/is not valid JSON; fix or remove it\n$/u) as unknown,
    code: 2,
  });

  const config = await readFile(resolveConfigPath(ctx.env), 'utf8');

  expect(config).toBe('{ damaged');
});

test('#host makes a saved host current on host use', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: {
      home: { url: 'https://home.example', token: 'home-token' },
      work: { url: 'https://work.example', token: 'work-token' },
    },
  });

  const used = await runCLIInProcess({ args: ['host', 'use', 'work'], env: ctx.env });

  expect(used.code).toBe(0);
  expect(readHostConfig(ctx.env).current).toBe('work');
});

test('#host refuses a host use of a host it has not saved', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'home-token' } },
  });

  const used = await runCLIInProcess({ args: ['host', 'use', 'nope'], env: ctx.env });

  expect(used).toStrictEqual({
    stdout: '',
    stderr: 'impz: no saved host nope (see impz host ls)\n',
    code: 2,
  });

  expect(readHostConfig(ctx.env).current).toBe('home');
});

test('#host forgets the current host and clears current on host rm', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'work',
    hosts: {
      home: { url: 'https://home.example', token: 'home-token' },
      work: { url: 'https://work.example', token: 'work-token' },
    },
  });

  const removed = await runCLIInProcess({ args: ['host', 'rm', 'work'], env: ctx.env });

  expect(removed.code).toBe(0);

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: null,
    hosts: { home: { url: 'https://home.example', token: 'home-token' } },
  });
});

test('#hostFlag sends the saved token over IMP_TOKEN, with a note', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: null,
    hosts: { work: { url: ctx.url, token: ctx.rootToken } },
  });

  const listed = await runCLIInProcess({
    args: ['--host', 'work', 'ls', '--json'],
    env: { ...ctx.env, IMP_TOKEN: 'ignored' },
  });

  expect(listed).toStrictEqual({
    stdout: '[]\n',
    stderr: 'impz: note: IMP_TOKEN is ignored; work uses its saved token\n',
    code: 0,
  });
});

test.skipIf(!probeUpdateReadOnly())(
  '#hostFlag reads its saved host when the old token file cannot move, and notes the file it left',
  async () => {
    const ctx = await setupTest();

    writeHostConfig(ctx.env, {
      current: null,
      hosts: { work: { url: ctx.url, token: ctx.rootToken } },
    });

    await mkdir(join(ctx.env.XDG_CONFIG_HOME, 'imp'));
    await writeFile(join(ctx.env.XDG_CONFIG_HOME, 'imp', 'token'), 'file-token\n');

    // released before the stack removes the home it locks
    const locks = new DisposableStack();

    ctx.stack.defer(() => {
      locks.dispose();
    });

    updateReadOnly(locks, join(ctx.env.XDG_CONFIG_HOME, 'imp'));

    const listed = await runCLIInProcess({
      args: ['--host', 'work', 'ls', '--json'],
      env: ctx.env,
    });

    const note = `impz: cannot move ${join(ctx.env.XDG_CONFIG_HOME, 'imp', 'token')} to ${join(ctx.env.XDG_CONFIG_HOME, 'impz', 'token')}, so it stays there: `;

    expect(listed).toStrictEqual({
      stdout: '[]\n',
      stderr: expect.toSatisfy(
        (text: string) => text.startsWith(note) && /EACCES|EPERM/u.test(text),
      ),
      code: 0,
    });

    const leftBehind = await readFile(join(ctx.env.XDG_CONFIG_HOME, 'imp', 'token'), 'utf8');

    expect(leftBehind).toBe('file-token\n');
  },
);

test('#hostFlag names the host in a 401 for a saved token impd refuses', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: { work: { url: ctx.url, token: 'stale' } } });

  const listed = await runCLIInProcess({ args: ['--host', 'work', 'ls'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: `impz: unauthorized: work (${ctx.url}) refused the token; run impz login ${ctx.url} --name work\n`,
    code: 1,
  });
});

test('#hostFlag names the host when impd refuses the saved token on exec’s socket', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: { work: { url: ctx.url, token: 'stale' } } });

  const exec = await runCLIInProcess({
    args: ['--host', 'work', 'exec', 'box', '--', 'true'],
    env: ctx.env,
  });

  expect(exec).toStrictEqual({
    stdout: '',
    stderr: `impz: unauthorized: work (${ctx.url}) refused the token; run impz login ${ctx.url} --name work\n`,
    code: 255,
  });
});

test('#hostFlag sends the saved token over IMP_TOKEN on exec’s socket', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await createImpClient({ url: ctx.url, token: ctx.rootToken }).imps.create({
    name: 'box',
    image: 'ubuntu',
  });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // impd runs outer execs only on an agent at 0.18.0 or later, and the stub
  // VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  await startStubExecAgent(paths.vsockSocket, buildStubExecGuest());

  writeHostConfig(ctx.env, {
    current: null,
    hosts: { work: { url: ctx.url, token: ctx.rootToken } },
  });

  const exec = await runCLIInProcess({
    args: ['--host', 'work', 'exec', 'box', '--', 'echo', 'ran'],
    env: { ...ctx.env, IMP_TOKEN: 'ignored' },
  });

  expect(exec).toStrictEqual({
    stdout: 'ran\n',
    stderr: 'impz: note: IMP_TOKEN is ignored; work uses its saved token\n',
    code: 0,
  });
});

test('#hostFlag refuses a flag without a saved host name', async () => {
  const ctx = await setupTest();
  const listed = await runCLIInProcess({ args: ['ls', '--host'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'impz: --host needs a saved host name (see impz host ls)\n',
    code: 2,
  });
});

test('#hostFlag leaves --version to print the version with no saved host', async () => {
  const ctx = await setupTest();

  const version: unknown = await runCLIInProcess({
    args: ['--host', 'work', '--version'],
    env: ctx.env,
  });

  expect(version).toStrictEqual({
    stdout: expect.stringMatching(/^\d+\.\d+\.\d+\n$/u) as unknown,
    stderr: '',
    code: 0,
  });
});

test('#hostFlag leaves --help to print the help with no saved host', async () => {
  const ctx = await setupTest();
  const help: unknown = await runCLIInProcess({ args: ['--host', 'work', '--help'], env: ctx.env });

  expect(help).toStrictEqual({
    stdout: expect.stringContaining('--host') as unknown,
    stderr: '',
    code: 0,
  });
});

test('#exec prints one line, not a stack, when it cannot read config.json', async () => {
  const ctx = await setupTest();

  await mkdir(resolveConfigPath(ctx.env), { recursive: true });

  const exec: unknown = await runCLIInProcess({
    args: ['exec', 'box', '--', 'true'],
    env: ctx.env,
  });

  expect(exec).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^impz: [^\n]*EISDIR[^\n]*\n$/u) as unknown,
    code: 255,
  });
});
