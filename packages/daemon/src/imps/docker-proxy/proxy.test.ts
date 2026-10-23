import { expect, jest, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { startStubDockerEngine } from '../../../testing/imps/start-stub-docker-engine';
import { startStubCutStream } from '../../../testing/network/start-stub-cut-stream';
import { startStubSilentOrigin } from '../../../testing/network/start-stub-silent-origin';
import { CREATE_BODY_MAX_BYTES, PROXY_LABEL, createDockerProxy } from './proxy';
import type { DockerProxyOptions } from './proxy';
import { readProxyRefusal } from './refusal';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'docker-proxy-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const engine = startStubDockerEngine({ directoryPath: directory });

  stack.defer(() => engine.stop());

  const logged: string[] = [];

  const startProxy = (options: Readonly<DockerProxyOptions>) => {
    const socket = join(directory, 'proxy.sock');

    // Bun's types leave idleTimeout off unix servers, but it applies there too
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const server = Bun.serve({
      unix: socket,
      fetch: createDockerProxy(options),
      maxRequestBodySize: CREATE_BODY_MAX_BYTES + 1024 ** 2,
      idleTimeout: 0,
    } as unknown as Bun.Serve.Options<undefined>);

    stack.defer(() => server.stop(true));

    return (request: Request) =>
      fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        duplex: 'half',
        signal: request.signal,
        unix: socket,
      });
  };

  return {
    directoryPath: directory,
    engine,
    logged,
    log: (message: string) => {
      logged.push(message);
    },
    startProxy,
  };
}

test('it relays a ping to the engine with its API version', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/_ping', { method: 'HEAD' }));

  expect(response.headers.get('api-version')).toBe('1.55');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it relays a version call to the engine', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/v1.55/version'));
  const version: unknown = await response.json();

  expect(version).toStrictEqual({ ApiVersion: '1.55', Os: 'linux', Arch: 'amd64' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it relays an image inspect to the engine by the image name', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await proxy(new Request('http://docker/v1.55/images/docker.io/library/busybox:1.37/json'));

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/images/docker.io/library/busybox:1.37/json',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it sends the engine a create body of its own, with its label and no network', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Image:
          'ghcr.io/zgeoff/imp-base:0.29.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        Cmd: ['/bin/true'],
        AttachStdout: true,
        HostConfig: { NetworkMode: 'default' },
      }),
    }),
  );

  const [created] = ctx.engine.seen;

  invariant(created);

  expect(response.status).toBe(201);
  expect(ctx.engine.seen).toHaveLength(1);
  expect(created.target).toBe('/v1.55/containers/create');
  expect(ctx.engine.unexpected).toStrictEqual([]);

  expect(JSON.parse(new TextDecoder().decode(created.body))).toStrictEqual({
    Image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    Cmd: ['/bin/true'],
    Labels: { [PROXY_LABEL]: 'test-token' },
    HostConfig: { NetworkMode: 'none', RestartPolicy: { Name: 'no' } },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards no client header on a create', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      headers: { authorization: 'Bearer x', cookie: 'c=1' },
      body: JSON.stringify({
        Image:
          'ghcr.io/zgeoff/imp-base:0.29.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        Cmd: ['/bin/true'],
      }),
    }),
  );

  const [created] = ctx.engine.seen;

  invariant(created);

  expect(created.headers).not.toContainAnyKeys(['authorization', 'cookie']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create with a bind, and logs the refusal', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({
        Image:
          'ghcr.io/zgeoff/imp-base:0.29.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        Cmd: ['/bin/true'],
        HostConfig: { Binds: ['/:/host'] },
      }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);
  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: HostConfig.Binds is set' });
  expect(ctx.engine.seen).toStrictEqual([]);

  expect(ctx.logged).toStrictEqual([
    'refused POST /v1.55/containers/create: HostConfig.Binds is set',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create body over 1 MiB sent chunked', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const chunk = new Uint8Array(64 * 1024).fill(32);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 20; index += 1) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', { method: 'POST', body }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: the create body is larger than 1048576 bytes',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create body that is not JSON', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', { method: 'POST', body: '{nope' }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: the create body is not JSON' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create body with no Image', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Cmd: ['/bin/true'] }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: Image is missing' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it exports a container it created by its full ID', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await ctx.engine.addContainer({
    id: 'a'.repeat(64),
    labels: { [PROXY_LABEL]: 'test-token' },
    exportBytes: new TextEncoder().encode('tar bytes'),
  });

  const response = await proxy(new Request('http://docker/v1.55/containers/aaaa/export'));
  const tar = await response.text();

  expect(tar).toBe('tar bytes');

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/containers/aaaa/json',
    `GET /v1.55/containers/${'a'.repeat(64)}/export`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it removes a container it created by its full ID, with its volumes', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: { [PROXY_LABEL]: 'test-token' } });

  await proxy(new Request('http://docker/v1.55/containers/aaaa?force=1', { method: 'DELETE' }));

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/containers/aaaa/json',
    `DELETE /v1.55/containers/${'a'.repeat(64)}?force=1&v=1`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses the export of a container whose label holds another token', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'b'.repeat(64), labels: { [PROXY_LABEL]: '1' } });

  const response = await proxy(new Request('http://docker/v1.55/containers/bbbb/export'));
  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: container bbbb was not created by this proxy',
  });

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/containers/bbbb/json',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses the removal of a container whose label holds another token', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'b'.repeat(64), labels: { [PROXY_LABEL]: '1' } });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/bbbb?force=1', { method: 'DELETE' }),
  );

  expect(response.status).toBe(403);
  expect(ctx.engine.hasContainer('b'.repeat(64))).toBe(true);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses the removal of a container the engine does not have', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/cccc?force=1', { method: 'DELETE' }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: container cccc was not created by this proxy',
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a removal with a param docker rm -f does not send', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/aaaa?force=1&link=1', { method: 'DELETE' }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: param link is not allowed' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a param on a call that takes none', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/v1.55/version?format=x'));
  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: param format is not allowed' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build, and the engine sees no request', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/build?t=imp%2Fx%3Alatest&version=2', {
      method: 'POST',
      headers: { 'content-type': 'application/x-tar' },
      body: 'context',
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: POST /build is not a call impd makes',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards a pull with its fromImage, tag and registry auth', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await proxy(
    new Request(
      `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
      {
        method: 'POST',
        headers: { 'x-registry-auth': 'e30=', cookie: 'c=1' },
      },
    ),
  );

  const [pull] = ctx.engine.seen;

  invariant(pull);

  expect(pull.target).toBe(
    `/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
  );

  expect(pull.headers['x-registry-auth']).toBe('e30=');
  expect(pull.headers['cookie'] ?? null).toBe(null);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a pull with a body', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request(
      `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
      { method: 'POST', body: 'x' },
    ),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);
  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: a pull takes no body' });
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it ends a create the engine never answers at the control deadline, and the engine sees it go', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    controlCallMs: 50,
    log: ctx.log,
  });

  const gone = Promise.withResolvers<void>();

  ctx.engine.setAnswer(async (request) => {
    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    gone.resolve();

    return new Response(null, { status: 499 });
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({
        Image:
          'ghcr.io/zgeoff/imp-base:0.29.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        Cmd: ['/bin/true'],
      }),
    }),
  );

  await gone.promise;

  expect(response.status).toBe(502);
  expect(ctx.logged).toHaveLength(1);
  expect(ctx.logged[0]).toStartWith('error on POST /v1.55/containers/create: ');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it holds a pull and an export past the control deadline that ends a create', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    controlCallMs: 50,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: { [PROXY_LABEL]: 'test-token' } });

  const release = Promise.withResolvers<void>();

  ctx.engine.setAnswer(async (request, seen) => {
    const isLong =
      seen.target.startsWith('/v1.55/images/create') || seen.target.endsWith('/export');

    if (isLong) {
      await release.promise;

      return null;
    }

    if (seen.target === '/v1.55/containers/create') {
      await new Promise((resolve) => {
        request.signal.addEventListener('abort', resolve);
      });

      return new Response(null, { status: 499 });
    }

    return null;
  });

  const long = [
    proxy(
      new Request(
        `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
        { method: 'POST' },
      ),
    ),
    proxy(new Request('http://docker/v1.55/containers/aaaa/export')),
  ];

  await waitFor(() => {
    expect(ctx.engine.seen).toHaveLength(3);
  });

  const created = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({
        Image:
          'ghcr.io/zgeoff/imp-base:0.29.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        Cmd: ['/bin/true'],
      }),
    }),
  );

  release.resolve();

  const answered = await Promise.all(long);

  expect(created.status).toBe(502);
  expect(answered.map((response) => response.status)).toStrictEqual([200, 200]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// Bun reads its fetch idle limit only at startup, so the proxy runs in a child Bun with a 1 s
// limit. The child's plain fetch gives up after about 8 s.
test('it passes on a pull and an export that stay silent past Bun’s idle limit, where a plain fetch gives up', async () => {
  const ctx = await setupTest();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const socket = join(ctx.directoryPath, 'silent-engine.sock');

  startStubSilentOrigin(stack, {
    unix: socket,
    answerAtOnce: (request) =>
      request.url.endsWith('/json')
        ? Response.json({ Id: 'a'.repeat(64), Config: { Labels: { [PROXY_LABEL]: 'test-token' } } })
        : null,
  });

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../../../testing/surface/run-idle-limited-requests.ts'),
      JSON.stringify({ via: 'docker-proxy', socket }),
    ],
    {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  stack.defer(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  const lines = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: false, error: 'TimeoutError' },
    { kind: 'pull', isOk: true, status: 200, body: 'the long answer' },
    { kind: 'export', isOk: true, status: 200, body: 'the long answer' },
  ]);
}, 30_000);

test('it passes on a pull and an export the engine answers after 400 s of fake time', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: { [PROXY_LABEL]: 'test-token' } });

  const release = Promise.withResolvers<void>();
  const bothHeld = Promise.withResolvers<void>();
  const held = { count: 0 };

  onTestFinished(() => {
    release.resolve();
  });

  ctx.engine.setAnswer(async (_request, seen) => {
    if (seen.target.startsWith('/v1.55/images/create') || seen.target.endsWith('/export')) {
      held.count += 1;

      if (held.count === 2) {
        bothHeld.resolve();
      }

      await release.promise;
    }

    return null;
  });

  jest.useFakeTimers();

  onTestFinished(() => {
    jest.useRealTimers();
  });

  const long = [
    proxy(
      new Request(
        `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
        { method: 'POST' },
      ),
    ),
    proxy(new Request('http://docker/v1.55/containers/aaaa/export')),
  ];

  await bothHeld.promise;

  jest.advanceTimersByTime(400_000);
  jest.useRealTimers();
  release.resolve();

  const answered = await Promise.all(long);

  expect(answered.map((response) => response.status)).toStrictEqual([200, 200]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it answers 502 with the engine failure when the engine is unreachable', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: join(ctx.directoryPath, 'no-engine.sock'),
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/_ping'));
  const failure: unknown = await response.json();

  expect(response.status).toBe(502);

  expect(failure).toStrictEqual({
    message: expect.stringMatching(/^imp-docker-proxy: the engine call failed: /v) as unknown,
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create from another image', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Image: 'busybox:1.37', Cmd: ['/bin/true'] }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: `imp-docker-proxy: a create from busybox:1.37 is refused: the proxy creates only from IMP_BUILD_IMAGE, ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it passes a create from IMP_BUILD_IMAGE by its digest', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({
        Image: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
        Cmd: ['/bin/true'],
      }),
    }),
  );

  expect(response.status).toBe(201);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a pull of another image', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/images/create?fromImage=busybox&tag=1.37', {
      method: 'POST',
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: `imp-docker-proxy: a pull of busybox:1.37 is refused: the proxy pulls only IMP_BUILD_IMAGE, ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards a pull of IMP_BUILD_IMAGE by its digest', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    log: ctx.log,
  });

  await proxy(
    new Request(
      `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=${digest}`,
      { method: 'POST' },
    ),
  );

  expect(ctx.engine.seen.map((request) => request.target)).toStrictEqual([
    `/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=${encodeURIComponent(digest)}`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a pull from a loopback registry with a refusal that reads back alone', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/images/create?fromImage=localhost%3A5320%2Fx&tag=1', {
      method: 'POST',
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(403);
  expect(ctx.engine.seen).toStrictEqual([]);

  expect(readProxyRefusal(body)).toBe(
    "imp-docker-proxy: registry localhost:5320 is the host's own",
  );

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create from a loopback registry with a refusal the CLI stderr reads back', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Image: 'localhost:5320/x:1', Cmd: ['/bin/true'] }),
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(403);
  expect(ctx.engine.seen).toStrictEqual([]);

  expect(readProxyRefusal(`Error response from daemon: ${body}`)).toBe(
    "imp-docker-proxy: registry localhost:5320 is the host's own",
  );

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses an Upgrade request', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/_ping', {
      headers: { upgrade: 'h2c', connection: 'Upgrade' },
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: an Upgrade request is not a call impd makes',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a route impd does not call', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/containers/${'a'.repeat(64)}/start`, { method: 'POST' }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: `imp-docker-proxy: POST /containers/${'a'.repeat(64)}/start is not a call impd makes`,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// Bun prints a response body's unhandled error to the process's stderr, out
// of reach of the test runner, so the proxy runs in a child Bun whose stderr
// the test reads
test('it logs one impd.docker-proxy line, and nothing unhandled, when the engine closes a stream', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../../../testing/imps/run-cut-docker-proxy-stream.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  // an older Bun leaves the error's code out of a fetch error's message
  expect(stdout).toMatch(
    /^WARNING impd\.docker-proxy the engine closed POST \/v1\.55\/images\/create mid-stream: (?:ECONNRESET: )?The socket connection was closed unexpectedly\. For more information, pass `verbose: true` in the second argument to fetch\(\)\n\{"client":"ECONNRESET"\}\n$/v,
  );

  expect(stderr).toBe('');
}, 30_000);

test('it warns through its logger when the engine closes a stream', async () => {
  const ctx = await setupTest();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const socket = join(ctx.directoryPath, 'cut-engine.sock');

  const engine = startStubCutStream(stack, '{"status":"Pulling from library/busybox"}\n', {
    unix: socket,
  });

  const warning = mock();

  const proxy = ctx.startProxy({
    upstreamSocket: socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
    logger: { warning },
  });

  const response = await proxy(
    new Request(
      `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
      { method: 'POST' },
    ),
  );

  invariant(response.body);

  const reader = response.body.getReader();

  await reader.read();

  engine.cut();

  await Promise.allSettled([reader.read()]);

  expect(warning).toHaveBeenCalledExactlyOnceWith(
    'the engine closed {method} {path} mid-stream: {reason}',
    {
      method: 'POST',
      path: '/v1.55/images/create',
      reason: expect.stringMatching(
        /^(?:ECONNRESET: )?The socket connection was closed unexpectedly\./v,
      ),
    },
  );
});

test('it warns nothing when the engine ends a stream', async () => {
  const ctx = await setupTest();

  const warning = mock();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: ctx.log,
    logger: { warning },
  });

  await ctx.engine.addContainer({
    id: 'a'.repeat(64),
    labels: { [PROXY_LABEL]: 'test-token' },
    exportBytes: new TextEncoder().encode('tar bytes'),
  });

  const response = await proxy(new Request('http://docker/v1.55/containers/aaaa/export'));

  await response.text();

  expect(warning).not.toHaveBeenCalled();
});
