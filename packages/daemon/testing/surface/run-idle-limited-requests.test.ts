import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROXY_LABEL } from '../../src/imps/docker-proxy/proxy';

test('it prints the outcome of imp-docker-proxy’s pull and export as JSON lines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idle-limited-engine-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const socket = join(directory, 'engine.sock');

  // the proxy inspects a container for its own label before an export, so the inspect
  // answers with a labelled container
  const engine = Bun.serve({
    unix: socket,
    routes: {
      '/*': async (request: Request) => {
        await request.text();

        const path = new URL(request.url).pathname;

        return path.endsWith('/json')
          ? Response.json({
              Id: 'a'.repeat(64),
              Config: { Labels: { [PROXY_LABEL]: 'test-token' } },
            })
          : new Response(`answered ${path}`);
      },
    },
  });

  onTestFinished(() => engine.stop(true));

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-idle-limited-requests.ts'),
      JSON.stringify({ via: 'docker-proxy', socket }),
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  const lines = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: true, status: 200, body: 'answered /control' },
    { kind: 'pull', isOk: true, status: 200, body: 'answered /v1.55/images/create' },
    {
      kind: 'export',
      isOk: true,
      status: 200,
      body: `answered /v1.55/containers/${'a'.repeat(64)}/export`,
    },
  ]);
});

test.each(['long-request', 'wake-proxy'])(
  'it prints each outcome as a JSON line through %s',
  async (via) => {
    const origin = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: {
        '/*': async (request: Request) => {
          await request.text();

          return new Response(`answered ${new URL(request.url).pathname}`);
        },
      },
    });

    onTestFinished(() => origin.stop(true));

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'run-idle-limited-requests.ts'),
        JSON.stringify({ origin: `http://127.0.0.1:${String(origin.port)}`, via }),
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    );

    onTestFinished(() => {
      child.kill();
    });

    const output = await new Response(child.stdout).text();

    const lines = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);

    expect(lines).toIncludeSameMembers([
      { kind: 'control', isOk: true, status: 200, body: 'answered /control' },
      { kind: 'long', isOk: true, status: 200, body: 'answered /long' },
    ]);
  },
);
