import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/db/images';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubImpdReleaseFetch,
  startTestImpd,
} from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { UsageError } from '../cli/errors';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startWarmMoveHosts } from '../test-utils/start-warm-move-hosts';
import { runMove } from './move-command';

// two impds, a and b, each with the image its imps boot from
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // each call the CLI makes, as `<host> <procedure>`, in the order impd took them
  const calls: string[] = [];

  const startImpd = async (host: string) => {
    // named for its host, as a refused warm move prints it
    const dataDir = await mkdtemp(join(tmpdir(), `cli-move-${host}-`));

    stack.defer(() => rm(dataDir, { recursive: true, force: true }));

    // on the wall clock until a test moves it on
    const harness = await startTestImpd(stack, {
      dataDir,
      rootToken: 'root-token',

      // the URL the target hands the source, a tailnet address as a move needs
      env: { IMP_PEER_URL: 'http://100.100.0.2:7070' },
    });

    const impd = harness.impd;

    // the image a test's imps boot from
    await Bun.write(join(harness.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

    await createImage(
      harness.db,
      buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
    );

    // the image's config, which a move sends with it
    await Bun.write(buildImagePaths(harness.dataDir, 'sha256:ubuntu').config, '{}');

    const client = createImpClient({
      url: `http://${host}.test`,
      token: 'root-token',
      fetch: (request) => {
        calls.push(`${host} ${new URL(request.url).pathname.slice('/rpc/'.length)}`);

        return impd.api.app.handle(request);
      },
    });

    return {
      client,

      // a test moves a host's clock on, such as past the target's commit window
      advance: harness.advance,
      moves: impd.moves,
      handle: (request: Request) => impd.api.app.handle(request),
    };
  };

  const source = await startImpd('a');
  const target = await startImpd('b');

  return {
    calls,
    from: source.client,
    to: target.client,

    // the target's API, as a client in front of it reaches it
    handleOnTarget: target.handle,

    // moves the target's clock on, as a test may
    advanceTarget: target.advance,

    // the target's move routes, as the source reaches them over the
    // tailnet from 100.100.0.1
    receiveFromSource: (request: Request) => target.moves.handle(request, '100.100.0.1'),
  };
}

test('it prepares on the source, takes a ticket from the target, then sends', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)));

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  const moved = await ctx.to.imps.get({ name: 'dev' });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b');
  expect(moved.state).toBe('stopped');

  expect(
    ctx.calls.filter((call) =>
      ['a moves/prepare', 'b moves/receive', 'a moves/send'].includes(call),
    ),
  ).toStrictEqual(['a moves/prepare', 'b moves/receive', 'a moves/send']);
});

test('it draws the send’s progress on a terminal and ends the line', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)));

  const print = mock<(line: string) => void>();
  const write = mock<(text: string) => void>();

  // a clock past the redraw interval at every read, so each poll draws
  const clock = { nowMs: 0 };

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: true, write },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => (clock.nowMs += 300),
  });

  const lines = write.mock.calls.map(([text]) => text);

  expect(lines.at(-1)).toBe('\n');
  expect(lines.slice(0, -1)).not.toBeEmpty();

  // the source's count starts over once the send is done; the line keeps
  // the bytes it showed
  const percents = lines
    .slice(0, -1)
    .map((line) => Number(/(?<percent>\d+)%/u.exec(line)?.groups?.['percent']));

  expect(percents).toStrictEqual(percents.toSorted((a, b) => a - b));
  expect(percents.at(-1)).toBeGreaterThan(0);

  expect(lines.slice(0, -1)).toSatisfyAll(
    (line: string) =>
      line.startsWith('\r') &&
      line.endsWith('\u001B[K') &&
      /^impz move: \d+% \d+(?:\.\d)? [KMG]?i?B of \d+(?:\.\d)? [KMG]?i?B$/u.test(line.slice(1, -3)),
  );
});

test('it moves an imp that holds leases for --stop, which ends them as impz stop does', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.leases.acquire({ name: 'dev', label: 'ci', ttlSeconds: 600 });

  const held = await ctx.from.leases.list({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)));

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: true,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  const moved = await ctx.to.imps.get({ name: 'dev' });
  const leases = await ctx.to.leases.list({ name: 'dev' });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b');
  expect(held).toHaveLength(1);
  expect(moved.state).toBe('stopped');
  expect(leases).toBeEmpty();
});

test('it refuses to move a sleeping imp with its memory when the target’s data dir differs', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.sleep({ name: 'dev' });

  const print = mock<(line: string) => void>();

  // two impds in one process never share a data dir, so the source's
  // check of the target's facts refuses the warm move it would make
  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrow(
    /^dev cannot move with its memory: IMP_DATA_DIR differs \(\S+cli-move-a-\S+ here, \S+cli-move-b-\S+ there\)/u,
  );
});

test('it prepares a sleeping imp without facts when the target is an older impd with none to give', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.sleep({ name: 'dev' });

  // an impd from before warm moves (0.38.0) has no moves.facts
  const older = buildStubImpdReleaseFetch(ctx.handleOnTarget, {
    withoutProcedures: ['moves/facts'],
  });

  const to = createImpClient({ url: 'http://b.test', token: 'root-token', fetch: older.fetch });

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print: () => {},
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrow(/^dev cannot move with its memory: the target does not say what it can load/u);
});

test('it moves a sleeping imp with its memory and says it moved asleep', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await startWarmMoveHosts(stack);

  await hosts.from.imps.create({ name: 'dev', image: 'ubuntu' });
  await hosts.from.imps.sleep({ name: 'dev' });

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: hosts.from,
    to: hosts.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  const moved = await hosts.to.imps.get({ name: 'dev' });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b, asleep with its memory');
  expect(moved.state).toBe('sleeping');
});

test('it takes the source’s mark off when the target refuses the ticket', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });
  await ctx.to.imps.create({ name: 'dev' });

  const print = mock<(line: string) => void>();

  const moving = runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(moving).rejects.toThrow('this host has an imp named dev');

  const status = await ctx.from.moves.status({ name: 'dev' });

  expect(status.state).toBeNull();
});

test('it points at --resume when the target’s commit window ended before the commit', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  // the commit window is 24 hours from the receipt
  // (docs/architecture/storage/moves.md#one-live-copy); the commit lands a second past it
  server.use(
    http.post('http://100.100.0.2:7070/move/commit', (info) => {
      ctx.advanceTarget(24 * 60 * 60 * 1000 + 1000);

      return ctx.receiveFromSource(info.request);
    }),
    http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)),
  );

  const print = mock<(line: string) => void>();

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'dev: the move failed: commit: the target answered 410 the commit window ended; reissue the ticket; run impz move dev b --resume, or --abort',
  );
});

test('it points at --abort when the network to the target is down', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', () => HttpResponse.error()));

  const print = mock<(line: string) => void>();

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'dev: the move failed: Failed to fetch; the imp stays marked here: run impz move dev b --abort once b answers',
  );
});

test('it commits a verified move with a fresh ticket from the target on --resume after the commit window ended', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  // the first commit lands a second past the 24-hour commit window
  // (docs/architecture/storage/moves.md#one-live-copy), so the target holds a verified copy
  server.use(
    http.post(
      'http://100.100.0.2:7070/move/commit',
      (info) => {
        ctx.advanceTarget(24 * 60 * 60 * 1000 + 1000);

        return ctx.receiveFromSource(info.request);
      },
      { once: true },
    ),
    http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)),
  );

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  }).catch(() => {
    // the first run fails at the commit, as arranged
  });

  print.mockClear();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'resume',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  const moved = await ctx.to.imps.get({ name: 'dev' });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b');
  expect(moved.name).toBe('dev');
});

test('it says the move is complete when an abort finds the target committed it', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  // the target commits, but its answer is lost on the way back
  server.use(
    http.post(
      'http://100.100.0.2:7070/move/commit',
      async (info) => {
        await ctx.receiveFromSource(info.request);

        return HttpResponse.error();
      },
      { once: true },
    ),
    http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)),
  );

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  }).catch(() => {
    // the first run fails at the commit, as arranged
  });

  print.mockClear();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'abort',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(print).toHaveBeenCalledExactlyOnceWith(
    'dev: b had committed it already; the move is complete',
  );
});

test('it says an abort leaves the imp here when no move is underway', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'abort',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: move aborted; it stays here');
});

test('it refuses --resume of an imp with no verified move', async () => {
  const ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });

  const print = mock<(line: string) => void>();

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'resume',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrowWithMessage(
    UsageError,
    'dev has no verified move to resume (state: none); run impz move again',
  );
});

test('it refuses --resume together with --abort', async () => {
  const result = await runCLIInProcess({
    args: ['move', 'dev', 'b', '--resume', '--abort'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --resume and --abort do not go together\n',
    code: 2,
  });
});
