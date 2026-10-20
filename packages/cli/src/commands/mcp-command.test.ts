import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/platform/db/images';
import { readImpByName } from '@impz/daemon/src/platform/db/imps';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  buildStubExecGuest,
  startStubExecAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';

// impd's real app on a loopback port, where the `impz mcp` subprocess reaches
// it, the CLI's entry the tests run it from, a root client for the scenario,
// and `stack`, whose releases run before impd stops
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the subprocess's own HOME, so no run reads the developer's config
  const home = await mkdtemp(join(tmpdir(), 'mcp-stdio-home-'));

  stack.defer(() => rm(home, { recursive: true, force: true }));

  // the bearer the root client and the subprocess send
  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // the image every imps.create boots when it names none
  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  const url = harness.url;

  return {
    db: harness.db,
    dataDir: harness.dataDir,
    home,
    url,
    main: join(import.meta.dir, '..', 'main.ts'),
    client: createImpClient({ url, token: 'root-token' }),
    stack,
  };
}

test('it answers initialize over stdio, and nothing for a notification', async () => {
  const ctx = await setupTest();

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.home,
      IMP_URL: ctx.url,
      IMP_TOKEN: 'root-token',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stdout = new Response(subprocess.stdout).text();

  await subprocess.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );

  await subprocess.stdin.end();

  const code = await subprocess.exited;
  const text = await stdout;

  const messages = text
    .trimEnd()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(code).toBe(0);

  expect(messages).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: expect.any(String) as unknown },
        instructions: expect.stringContaining('imps named agent-*') as unknown,
      },
    },
  ]);
});

test('it lists its tools over stdio', async () => {
  const ctx = await setupTest();

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.home,
      IMP_URL: ctx.url,
      IMP_TOKEN: 'root-token',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stdout = new Response(subprocess.stdout).text();

  await subprocess.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
  );

  await subprocess.stdin.end();

  const code = await subprocess.exited;
  const text = await stdout;

  const [listed] = text.split('\n');

  invariant(listed !== undefined);

  expect(code).toBe(0);

  expect(JSON.parse(listed)).toMatchObject({
    id: 2,
    result: { tools: expect.toIncludeAllPartialMembers([{ name: 'imp_exec' }]) as unknown },
  });
});

test('it answers an unknown method over stdio with method not found', async () => {
  const ctx = await setupTest();

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.home,
      IMP_URL: ctx.url,
      IMP_TOKEN: 'root-token',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stdout = new Response(subprocess.stdout).text();

  await subprocess.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'prompts/list' })}\n`,
  );

  await subprocess.stdin.end();

  const code = await subprocess.exited;
  const text = await stdout;

  expect(code).toBe(0);

  expect(text).toBe(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32_601, message: 'unknown method: prompts/list' },
    })}\n`,
  );
});

test('it creates an imp through impd over stdio', async () => {
  const ctx = await setupTest();

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.home,
      IMP_URL: ctx.url,
      IMP_TOKEN: 'root-token',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stdout = { text: '' };

  void (async () => {
    for await (const chunk of subprocess.stdout.pipeThrough(new TextDecoderStream())) {
      stdout.text += chunk;
    }
  })();

  await subprocess.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'agent-a', image: 'ubuntu' } },
    })}\n`,
  );

  // the call stops when the input ends, so the input ends once it answers
  const answer = await waitFor(() => {
    // the text after the first newline, empty once the answer's line is whole
    const [line, rest] = stdout.text.split('\n');

    invariant(rest !== undefined);

    return line ?? '';
  });

  await subprocess.stdin.end();

  const imps = await ctx.client.imps.list();

  expect(JSON.parse(answer)).toMatchObject({
    id: 3,
    result: { isError: false, structuredContent: { imp: { name: 'agent-a', state: 'running' } } },
  });

  expect(imps.map((imp) => imp.name)).toStrictEqual(['agent-a']);
});

test('it runs a command in the guest over stdio', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'agent-a' });

  const record = await readImpByName(ctx.db, 'agent-a');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.home,
      IMP_URL: ctx.url,
      IMP_TOKEN: 'root-token',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stdout = { text: '' };

  void (async () => {
    for await (const chunk of subprocess.stdout.pipeThrough(new TextDecoderStream())) {
      stdout.text += chunk;
    }
  })();

  await subprocess.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'agent-a', command: 'echo from the guest' } },
    })}\n`,
  );

  // the call stops when the input ends, so the input ends once it answers
  const answer = await waitFor(() => {
    // the text after the first newline, empty once the answer's line is whole
    const [line, rest] = stdout.text.split('\n');

    invariant(rest !== undefined);

    return line ?? '';
  });

  await subprocess.stdin.end();

  expect(JSON.parse(answer)).toMatchObject({
    id: 4,
    result: { structuredContent: { exitCode: 0, stdout: 'from the guest\n' } },
  });
});

test('it stops a command still running in the guest when the client goes away', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await readImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp', '--allow', 'box'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.home,
      IMP_URL: ctx.url,
      IMP_TOKEN: 'root-token',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stdout = new Response(subprocess.stdout).text();

  await subprocess.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
    })}\n`,
  );

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await subprocess.stdin.end();

  const code = await subprocess.exited;

  await waitFor(() => {
    invariant(guest.signals[0] !== undefined);
  });

  const text = await stdout;

  expect(code).toBe(0);
  expect(guest.signals).toStrictEqual(['sleepy:15']);
  expect(text).toBe('');
});

test('it exits 2 without a guard and says how to choose one', async () => {
  const ctx = await setupTest();

  const subprocess = Bun.spawn(['bun', ctx.main, 'mcp'], {
    env: { PATH: process.env['PATH'] ?? '', HOME: ctx.home, IMP_URL: 'http://127.0.0.1:1' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const [code, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);

  expect(code).toBe(2);
  expect(stderr).toBe('impz: choose the imps this server may touch: --prefix, --allow or --all\n');
});
