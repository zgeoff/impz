import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_BUILD_STREAM_TYPE } from '@impz/api';
import type { ImageBuildProgress } from '@impz/api';
import { createImpClient } from '@impz/client';
import { buildStubImpdBeforeBuildStream } from '@impz/client/test-utils/build-stub-impd-before-build-stream';
import { buildStubImageBuilder, createFilesTar, startBuilderImpd } from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import { http } from 'msw';
import invariant from 'tiny-invariant';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = 'root-token';

  const workDir = await mkdtemp(join(tmpdir(), 'imp-client-engine-'));

  stack.defer(() => rm(workDir, { recursive: true, force: true }));

  const startImpd = async (
    builder: Parameters<typeof startBuilderImpd>[1],
    boundaries: Readonly<{ keepaliveMs?: number }> = {},
  ) => {
    const harness = await startBuilderImpd(stack, builder, {
      rootToken,
      frozenClockMs: Date.UTC(2026, 0, 1),
      boundaries,
    });

    return { impd: harness.impd, url: `${harness.url}/` };
  };

  return {
    startImpd,
    workDir,
    rootToken,
  };
}

test('it throws PAYLOAD_TOO_LARGE for a context over the limit impd keeps', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const host = await ctx.startImpd(builder);

  const client = createImpClient({ url: host.url, token: ctx.rootToken });

  // fetch keeps the declared size only for a stream the caller made, and it
  // fails a request whose stream ends short of that size, so this one stays open
  const context = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('tar'));
    },
  });

  const building = client.buildImage('big', context, { size: 1024 ** 3 + 1 });

  expect(building).rejects.toBeInstanceOf(ORPCError);
  expect(building).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
});

test('it throws BAD_REQUEST for a Dockerfile outside the context', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const host = await ctx.startImpd(builder);

  const client = createImpClient({ url: host.url, token: ctx.rootToken });

  expect(
    client.buildImage('web', new Blob(['tar']), { dockerfile: '../Dockerfile' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
});

test('it throws UNAUTHORIZED for a wrong token', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const host = await ctx.startImpd(builder);

  const client = createImpClient({ url: host.url, token: 'wrong' });

  expect(client.buildImage('web', new Blob(['tar']))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    status: 401,
  });
});

test('it uploads a Blob as the build context and answers the image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'as a blob');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: host.url, token: ctx.rootToken });

  const built = await client.buildImage('web', new Blob([tar]));

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: builder.builtContexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
  });

  expect(note.stdout.toString()).toBe('as a blob');
});

test('it uploads bytes as the build context', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'as bytes');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: host.url, token: ctx.rootToken });

  const built = await client.buildImage('web', new Uint8Array(tar));

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: builder.builtContexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
  });

  expect(note.stdout.toString()).toBe('as bytes');
});

test('it uploads a stream as the build context', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'as a stream');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: host.url, token: ctx.rootToken });

  const built = await client.buildImage('web', new Blob([tar]).stream());

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: builder.builtContexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
  });

  expect(note.stdout.toString()).toBe('as a stream');
});

test('it sends the name, the Dockerfile, the token and what it accepts', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context', 'sub'), { recursive: true });
  await writeFile(join(ctx.workDir, 'context', 'sub', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const received = mock<(url: string, headers: Readonly<Record<string, string>>) => void>();

  server.use(
    http.post('http://impd.test/images/build', (info) => {
      received(info.request.url, Object.fromEntries(info.request.headers));

      return host.impd.api.app.handle(info.request);
    }),
  );

  const client = createImpClient({ url: 'http://impd.test/', token: ctx.rootToken });

  await client.buildImage('web', new Blob([tar]), { dockerfile: 'sub/Dockerfile' });

  const [call] = received.mock.calls;

  expect(received).toHaveBeenCalledOnce();
  expect(call?.[0]).toBe('http://impd.test/images/build?name=web&dockerfile=sub%2FDockerfile');

  expect(call?.[1]).toContainEntries([
    ['authorization', `Bearer ${ctx.rootToken}`],
    ['content-type', 'application/x-tar'],
    ['accept', `${IMAGE_BUILD_STREAM_TYPE}, application/json`],
  ]);
});

test('it sends the size of a stream as its Content-Length, which impd builds to', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'with its size');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: host.url, token: ctx.rootToken });

  // fetch keeps the declared size only for a stream the caller made.
  const context = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(tar.subarray(0, 512));
      controller.enqueue(tar.subarray(512));
      controller.close();
    },
  });

  const built = await client.buildImage('web', context, { size: tar.byteLength });

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: builder.builtContexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
  });

  expect(note.stdout.toString()).toBe('with its size');
});

test(
  'it outlasts the idle deadline of a client fetch on progress lines while the engine is silent',
  async () => {
    const ctx = await setupTest();

    const release = Promise.withResolvers<void>();

    onTestFinished(() => {
      release.resolve();
    });

    const builder = buildStubImageBuilder({
      exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
      repoDigest: `sha256:${'b'.repeat(64)}`,
      onBuild: async () => {
        await release.promise;

        return {};
      },
    });

    const host = await ctx.startImpd(builder, { keepaliveMs: 500 });

    await mkdir(join(ctx.workDir, 'context'));
    await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

    await writeFile(
      join(ctx.workDir, 'context.tar'),
      Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout,
    );

    // Bun reads the idle deadline at startup, so the client runs in a process
    // of its own.
    await writeFile(
      join(ctx.workDir, 'build.ts'),
      [
        `import { createImpClient } from ${JSON.stringify(Bun.resolveSync('@impz/client', import.meta.dir))};`,
        'const [url, token, contextPath] = process.argv.slice(2);',
        'const client = createImpClient({ url, token });',
        'const onProgress = (event: unknown) => console.log(JSON.stringify(event));',
        'await client.buildImage("web", Bun.file(contextPath), { onProgress }).then(',
        '  (image) => console.log(JSON.stringify({ type: "image", name: image.name })),',
        '  (error) => console.log(JSON.stringify({ type: "error", name: error.name })),',
        ');',
      ].join('\n'),
    );

    // Bun's fetch gives up after about 8 s with no byte under this setting
    const child = Bun.spawn(
      [
        process.execPath,
        join(ctx.workDir, 'build.ts'),
        host.url,
        ctx.rootToken,
        join(ctx.workDir, 'context.tar'),
      ],
      {
        cwd: ctx.workDir,
        env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
        stdout: 'pipe',
      },
    );

    onTestFinished(() => {
      child.kill();
    });

    const output: string[] = [];

    const reading = (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        output.push(chunk);
      }
    })();

    await waitFor(
      () => {
        expect(output.join('')).toIncludeRepeated('"phase":"build"', 28);
      },
      { timeoutMs: 20_000, intervalMs: 100 },
    );

    release.resolve();

    await reading;

    const exitCode = await child.exited;

    expect(output.join('').trimEnd().split('\n').at(-1)).toBe('{"type":"image","name":"web"}');
    expect(exitCode).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  'it gives up at the idle deadline of a client fetch on an impd from before the stream, which stops the build',
  async () => {
    const ctx = await setupTest();

    const builder = buildStubImageBuilder({
      exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
      repoDigest: `sha256:${'b'.repeat(64)}`,
      onBuild: () => Promise.withResolvers<never>().promise,
    });

    const host = await ctx.startImpd(builder, { keepaliveMs: 500 });

    await mkdir(join(ctx.workDir, 'context'));
    await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

    await writeFile(
      join(ctx.workDir, 'context.tar'),
      Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout,
    );

    // Bun reads the idle deadline at startup, so the client runs in a process
    // of its own.
    await writeFile(
      join(ctx.workDir, 'build.ts'),
      [
        `import { createImpClient } from ${JSON.stringify(Bun.resolveSync('@impz/client', import.meta.dir))};`,
        `import { buildStubImpdBeforeBuildStream } from ${JSON.stringify(Bun.resolveSync('@impz/client/test-utils/build-stub-impd-before-build-stream', import.meta.dir))};`,
        'const [url, token, contextPath] = process.argv.slice(2);',
        'const client = createImpClient({ url, token, fetch: buildStubImpdBeforeBuildStream(fetch) });',
        'await client.buildImage("web", Bun.file(contextPath)).then(',
        '  (image) => console.log(JSON.stringify({ type: "image", name: image.name })),',
        '  (error) => console.log(JSON.stringify({ type: "error", name: error.name })),',
        ');',
      ].join('\n'),
    );

    // Bun's fetch gives up after about 8 s with no byte under this setting
    const child = Bun.spawn(
      [
        process.execPath,
        join(ctx.workDir, 'build.ts'),
        host.url,
        ctx.rootToken,
        join(ctx.workDir, 'context.tar'),
      ],
      {
        cwd: ctx.workDir,
        env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
        stdout: 'pipe',
      },
    );

    onTestFinished(() => {
      child.kill();
    });

    const output = new Response(child.stdout).text();

    const build = await waitFor(() => {
      const run = builder.guest.runs.find((candidate) => candidate.argv[1] === 'build');

      invariant(run);

      expect(builder.builtContexts).toBeArrayOfSize(1);

      return run;
    });

    const heldAt = Date.now();

    const exitCode = await child.exited;

    const gaveUpAfterMs = Date.now() - heldAt;

    const closed = await waitFor(() => {
      expect(build.closed).toBeTrue();

      return build.closed;
    });

    const images = await createImpClient({ url: host.url, token: ctx.rootToken }).images.list();
    const said = await output;

    expect(said).toBe('{"type":"error","name":"TimeoutError"}\n');
    expect(exitCode).toBe(0);
    expect(gaveUpAfterMs).toBeWithin(7000, 9000);
    expect(closed).toBeTrue();
    expect(images.map((image) => image.name)).toStrictEqual(['imp-builder']);
  },
  { timeout: 30_000 },
);

test('it reports each progress line as it arrives, before the image', async () => {
  const ctx = await setupTest();

  const release = Promise.withResolvers<void>();

  onTestFinished(() => {
    release.resolve();
  });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await release.promise;

      return {};
    },
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const progress = mock<(event: ImageBuildProgress) => void>();
  const client = createImpClient({ url: host.url, token: ctx.rootToken });
  const building = client.buildImage('web', new Blob([tar]), { onProgress: progress });

  await waitFor(() => {
    expect(progress).toHaveBeenLastCalledWith({ type: 'progress', phase: 'build', elapsedMs: 0 });
  });

  const statusWhileBuilding = Bun.peek.status(building);

  release.resolve();

  const built = await building;

  expect(statusWhileBuilding).toBe('pending');

  expect(progress.mock.calls).toStrictEqual([
    [{ type: 'progress', phase: 'upload', elapsedMs: 0 }],
    [{ type: 'progress', phase: 'build', elapsedMs: 0 }],
    [{ type: 'progress', phase: 'unpack', elapsedMs: 0 }],
  ]);

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
  });
});

test('it throws the ORPCError of the error line that ends the stream', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: () => ({ code: 1, stderr: 'the Dockerfile: no such file: note\n' }),
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: host.url, token: ctx.rootToken });
  const building = client.buildImage('web', new Blob([tar]));

  expect(building).rejects.toBeInstanceOf(ORPCError);

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    status: 400,
    message: expect.toInclude('the Dockerfile: no such file: note'),
  });
});

test('it answers the image from an impd that answers JSON, from before the stream', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const older = buildStubImpdBeforeBuildStream((request) => host.impd.api.app.handle(request));

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const progress = mock<(event: ImageBuildProgress) => void>();
  const client = createImpClient({ url: 'http://impd.test/', token: ctx.rootToken });

  const built = await client.buildImage('web', new Blob([tar]), { onProgress: progress });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
  });

  expect(progress).not.toHaveBeenCalled();
});

test('it throws the ORPCError that an impd from before the stream answers', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: () => ({ code: 1, stderr: 'the Dockerfile: no such file: note\n' }),
  });

  const host = await ctx.startImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const older = buildStubImpdBeforeBuildStream((request) => host.impd.api.app.handle(request));

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const client = createImpClient({ url: 'http://impd.test/', token: ctx.rootToken });
  const building = client.buildImage('web', new Blob([tar]));

  expect(building).rejects.toBeInstanceOf(ORPCError);

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    status: 400,
    message: expect.toInclude('the Dockerfile: no such file: note'),
  });
});
