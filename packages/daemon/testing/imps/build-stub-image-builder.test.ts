import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from '../../src/imps/docker-proxy/dockerfile-frontend';
import { createGuestExec } from '../../src/imps/images/guest-exec';
import { PIN_INSPECT_FORMAT } from '../../src/imps/images/image-pin';
import { STUB_BUILDER_CONTAINER, buildStubImageBuilder } from './build-stub-image-builder';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'stub-image-builder-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it answers the pin inspect of any image on linux/amd64 with its registry digest', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({
    Id: `sha256:${'c'.repeat(64)}`,
    RepoDigests: [`busybox@sha256:${'b'.repeat(64)}`],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {},
  });
});

test('it reports the engine platform as the version format renders it', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'version', '--format', '{{json .Server.Os}}'], {
    signal: new AbortController().signal,
  });

  expect(result.stdout).toBe('"linux" "x86_64"\n');
});

test('it records the Dockerfile of each context a build gets on stdin', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  await writeFile(join(ctx.directoryPath, 'Dockerfile'), 'FROM scratch\n');

  Bun.spawnSync([
    'tar',
    '-C',
    ctx.directoryPath,
    '-cf',
    join(ctx.directoryPath, 'context.tar'),
    'Dockerfile',
  ]);

  const answered = await builder.builders.withBuilder(new AbortController().signal, (exec) =>
    exec(['docker', 'build', '-'], {
      signal: new AbortController().signal,
      stdinPath: join(ctx.directoryPath, 'context.tar'),
    }),
  );

  expect(answered.exitCode).toBe(0);
  expect(builder.builtDockerfiles).toStrictEqual(['FROM scratch\n']);
});

test('it records the whole context tar each build gets on stdin', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  await writeFile(join(ctx.directoryPath, 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.directoryPath, 'note'), 'in the context');

  Bun.spawnSync([
    'tar',
    '-C',
    ctx.directoryPath,
    '-cf',
    join(ctx.directoryPath, 'context.tar'),
    'Dockerfile',
    'note',
  ]);

  await builder.builders.withBuilder(new AbortController().signal, (exec) =>
    exec(['docker', 'build', '-'], {
      signal: new AbortController().signal,
      stdinPath: join(ctx.directoryPath, 'context.tar'),
    }),
  );

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', 'note'], {
    stdin: builder.builtContexts.at(0) ?? new Uint8Array(),
  });

  expect(builder.builtContexts).toHaveLength(1);
  expect(note.stdout.toString()).toBe('in the context');
});

test('it writes the plain progress a test gives to the stderr of a build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    buildLog: '#4 [2/2] RUN make all\n#4 DONE 0.5s\n',
  });

  await writeFile(join(ctx.directoryPath, 'Dockerfile'), 'FROM scratch\n');

  Bun.spawnSync([
    'tar',
    '-C',
    ctx.directoryPath,
    '-cf',
    join(ctx.directoryPath, 'context.tar'),
    'Dockerfile',
  ]);

  const answered = await builder.builders.withBuilder(new AbortController().signal, (exec) =>
    exec(['docker', 'build', '-'], {
      signal: new AbortController().signal,
      stdinPath: join(ctx.directoryPath, 'context.tar'),
    }),
  );

  expect(answered.stderr).toBe('#4 [2/2] RUN make all\n#4 DONE 0.5s\n');
});

test('it names its builder as a real builder imp is named', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const name = await builder.builders.withBuilder(new AbortController().signal, (_exec, named) =>
    Promise.resolve(named),
  );

  expect(name).toMatch(/^imp-build-[a-z]{8}$/v);
});

test('it streams its export chunks for the container its create made', async () => {
  const builder = buildStubImageBuilder({
    exported: [new TextEncoder().encode('ab'), new TextEncoder().encode('cd')],
    repoDigest: 'sha256:1',
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'export', STUB_BUILDER_CONTAINER], {
    signal: new AbortController().signal,
  });

  expect(result.stdout).toBe('abcd');
});

test('it answers a pull as the test says', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    onPull: () => ({ code: 1, stderr: 'manifest unknown' }),
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'pull', '--quiet', 'x:1'], {
    signal: new AbortController().signal,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('manifest unknown');
});

test('it answers a build as the test says, after it records the Dockerfile', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    onBuild: () => ({ code: 1, stderr: 'RUN false: exit code 1' }),
  });

  await writeFile(join(ctx.directoryPath, 'Dockerfile'), 'FROM scratch\nRUN false\n');

  Bun.spawnSync([
    'tar',
    '-C',
    ctx.directoryPath,
    '-cf',
    join(ctx.directoryPath, 'context.tar'),
    'Dockerfile',
  ]);

  const answered = await builder.builders.withBuilder(new AbortController().signal, (exec) =>
    exec(['docker', 'build', '-'], {
      signal: new AbortController().signal,
      stdinPath: join(ctx.directoryPath, 'context.tar'),
    }),
  );

  expect(answered.exitCode).toBe(1);
  expect(answered.stderr).toBe('RUN false: exit code 1');
  expect(builder.builtDockerfiles).toStrictEqual(['FROM scratch\nRUN false\n']);
});

test('it fails a call it does not model and names it', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'run', 'x'], { signal: new AbortController().signal });

  expect(result.stderr).toBe('the stub builder has no run x');
});

test('it counts each builder booted and lets it go when its build fails', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const building = builder.builders.withBuilder(new AbortController().signal, () => {
    throw new Error('failed');
  });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'failed');
  expect(builder.readBoots()).toBe(1);
  expect(builder.readLive()).toBe(0);
});

test('it keeps a builder live while its build runs', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const live = await builder.builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve(builder.readLive()),
  );

  expect(live).toBe(1);
  expect(builder.readLive()).toBe(0);
});

test('it answers the config inspect of the built tag with a JSON object', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'imp-build:latest'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({ Cmd: ['/bin/sh'], Env: ['PATH=/bin'] });
});

test('it answers a create of the built tag with its container ID', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'create', 'imp-build:latest', '/bin/true'], {
    signal: new AbortController().signal,
  });

  expect(result.stdout).toBe(`${STUB_BUILDER_CONTAINER}\n`);
});

test('it answers the config inspect of the built tag with the config the test gives', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    config: '{"Cmd":["bash"]}\n',
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'imp-build:latest'],
    { signal: new AbortController().signal },
  );

  expect(result.stdout).toBe('{"Cmd":["bash"]}\n');
});

test('it reports the architecture the test gives for a pulled image', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    architecture: 'aarch64',
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({
    Id: `sha256:${'c'.repeat(64)}`,
    RepoDigests: [`busybox@sha256:${'b'.repeat(64)}`],
    Os: 'linux',
    Architecture: 'aarch64',
    Config: {},
  });
});

// each failure exits 1 with the stderr, as the docker CLI does for an
// engine error
test.each([
  ['pin', ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37']],
  ['tag', ['docker', 'tag', 'busybox:1.37', 'imp-build:latest']],
  ['config', ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'imp-build:latest']],
  ['create', ['docker', 'create', 'imp-build:latest', '/bin/true']],
  ['export', ['docker', 'export', STUB_BUILDER_CONTAINER]],
] as const)('it fails the %s step with the stderr the test gives', async (step, argv) => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    failures: { [step]: 'no space left on device' },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(argv, { signal: new AbortController().signal });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no space left on device\n' });
});

test('it keeps a stalled export open until the exec is closed', async () => {
  const exported = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [new TextEncoder().encode('ab')],
    repoDigest: 'sha256:1',
    isExportStalled: true,
    onExport: () => {
      exported.resolve();

      return Promise.resolve();
    },
  });

  const controller = new AbortController();

  const exec = createGuestExec(builder.guest.open);

  const exporting = exec(['docker', 'export', STUB_BUILDER_CONTAINER], {
    signal: controller.signal,
  });

  await exported.promise;

  controller.abort();

  expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
  expect(builder.guest.runs.at(-1)?.closed).toBeTrue();
});

test('it answers the pin inspect of an image in its table with the fields the test gives', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    images: {
      'base.test/onbuild:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
        Architecture: 'aarch64',
        OnBuild: ['RUN id'],
      },
    },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'base.test/onbuild:1'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({
    Id: `sha256:${'c'.repeat(64)}`,
    RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
    Os: 'linux',
    Architecture: 'aarch64',
    Config: { OnBuild: ['RUN id'] },
  });
});

test('it fails the pin inspect of an image its table lacks, as the engine does', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    images: { 'base.test/a:1': { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [] } },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'base.test/other:1'],
    { signal: new AbortController().signal },
  );

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Error response from daemon: No such image: base.test/other:1\n',
  });
});

test('it fails the pin inspect of a table image that is not on the engine', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    images: {
      'base.test/a:1': { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [], isOnEngine: false },
    },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'base.test/a:1'],
    { signal: new AbortController().signal },
  );

  expect(result.exitCode).toBe(1);
});

test('it answers the pin inspect of a table image once a pull brings it to the engine', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
        isOnEngine: false,
      },
    },
  });

  const exec = createGuestExec(builder.guest.open);

  await exec(['docker', 'pull', '--quiet', 'base.test/a:1'], {
    signal: new AbortController().signal,
  });

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'base.test/a:1'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({
    Id: `sha256:${'c'.repeat(64)}`,
    RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {},
  });
});

test('it fails the pull of a table image with the stderr the test gives', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    images: {
      'mnt.test/c:3': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [],
        isOnEngine: false,
        pullError: 'no such registry',
      },
    },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'pull', '--quiet', 'mnt.test/c:3'], {
    signal: new AbortController().signal,
  });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no such registry\n' });
});

test('it keeps a table image off the engine after its pull fails', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    images: {
      'base.test/a:1': { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [], isOnEngine: false },
    },
    onPull: () => ({ code: 1, stderr: 'manifest unknown' }),
  });

  const exec = createGuestExec(builder.guest.open);

  await exec(['docker', 'pull', '--quiet', 'base.test/a:1'], {
    signal: new AbortController().signal,
  });

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'base.test/a:1'],
    { signal: new AbortController().signal },
  );

  expect(result.exitCode).toBe(1);
});

test('it answers the inspect of the Dockerfile frontend with its ID by default', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', DOCKERFILE_FRONTEND],
    { signal: new AbortController().signal },
  );

  expect(result).toStrictEqual({ exitCode: 0, stdout: `sha256:${'f'.repeat(64)}\n`, stderr: '' });
});

test('it fails the inspect of a Dockerfile frontend the test leaves off the engine', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    frontend: { isOnEngine: false },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', DOCKERFILE_FRONTEND],
    { signal: new AbortController().signal },
  );

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `Error response from daemon: No such image: ${DOCKERFILE_FRONTEND}\n`,
  });
});

test('it answers the inspect of a Dockerfile frontend once a pull brings it', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    frontend: { isOnEngine: false },
  });

  const exec = createGuestExec(builder.guest.open);

  await exec(['docker', 'pull', '--quiet', DOCKERFILE_FRONTEND], {
    signal: new AbortController().signal,
  });

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', DOCKERFILE_FRONTEND],
    { signal: new AbortController().signal },
  );

  expect(result.stdout).toBe(`sha256:${'f'.repeat(64)}\n`);
});

test('it fails the pull of the Dockerfile frontend with the stderr the test gives', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    frontend: { isOnEngine: false, pullError: 'no route to host' },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'pull', '--quiet', DOCKERFILE_FRONTEND], {
    signal: new AbortController().signal,
  });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no route to host\n' });
});
