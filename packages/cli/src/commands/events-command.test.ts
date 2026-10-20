import { expect, mock, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { CLIENT_VERSION, ORPCError, createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/platform/db/images';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubImpdReleaseFetch,
  startTestImpd,
} from '@impz/daemon/testing';
import invariant from 'tiny-invariant';
import { buildStubBackoffClock } from '../test-utils/build-stub-backoff-clock';
import { printEvents } from './events-command';

// impd's real app, listening on a loopback port for the spawned CLI, and an
// in-process client of it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root bearer; each test reads it back for its client
  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  const impd = harness.impd;
  const port = harness.config.apiPort;

  // each listen after impd's own registers the stop of its own server; a
  // Bun server that a test stopped already stops again as a no-op
  const startListener = (): void => {
    impd.api.app.listen({ port, hostname: '127.0.0.1' });

    const server = impd.api.app.server;

    invariant(server, 'impd listens once listen returns');

    stack.defer(() => server.stop(true));
  };

  const sendRequest = (request: Request) => impd.api.app.handle(request);

  return {
    stack,
    sendRequest,
    rootToken,
    client: createImpClient({ url: 'http://impd.test', token: rootToken, fetch: sendRequest }),
    db: harness.db,
    dataDir: harness.dataDir,
    url: harness.url,
    stopListener: () => impd.api.app.stop(true),
    startListener,
  };
}

test('it prints only the named imp’s events, and reconnects after impd’s connection drops', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev', image: 'base' });
  await ctx.client.imps.create({ name: 'web', image: 'base' });

  const live = createImpClient({ url: ctx.url, token: ctx.rootToken });
  const warn = mock<(line: string) => void>();

  // impd comes back for the first reconnect only
  const backoff = buildStubBackoffClock({
    at: 1,
    onWait: () => {
      ctx.startListener();
    },
  });

  // each line drops impd's connection, as a restart does
  const print = mock<(line: string) => void>(() => {
    void ctx.stopListener();
  });

  const printing = printEvents(
    {
      events: live.events,
      checkServer: () => live.checkServer(),
      now: Date.now,
      wait: backoff.wait,
      warn,
    },
    'dev',
    print,
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: Unable to connect. Is the computer able to access the url?',
  );

  expect(print.mock.calls.map(([line]) => JSON.parse(line) as unknown)).toStrictEqual([
    expect.objectContaining({
      ev: 'ImpAdded',
      reason: 'snapshot',
      imp: expect.objectContaining({ name: 'dev' }) as unknown,
    }),
    expect.objectContaining({
      ev: 'ImpAdded',
      reason: 'snapshot',
      imp: expect.objectContaining({ name: 'dev' }) as unknown,
    }),
  ]);

  expect(backoff.delays).toStrictEqual([1000, 2000, 4000, 8000]);

  expect(warn.mock.calls).toStrictEqual([
    [
      'impz: the event stream ended (The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()); reconnecting in 1000ms',
    ],
    [
      'impz: the event stream ended (The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()); reconnecting in 2000ms',
    ],
    [
      'impz: the event stream ended (Unable to connect. Is the computer able to access the url?); reconnecting in 4000ms',
    ],
    [
      'impz: the event stream ended (Unable to connect. Is the computer able to access the url?); reconnecting in 8000ms',
    ],
  ]);
});

test('it prints every imp’s events when no imp is named', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev', image: 'base' });
  await ctx.client.imps.create({ name: 'web', image: 'base' });

  const live = createImpClient({ url: ctx.url, token: ctx.rootToken });
  const lines: string[] = [];

  const printing = printEvents(
    {
      events: live.events,
      checkServer: () => live.checkServer(),
      now: Date.now,
      wait: () => Promise.resolve(),
      warn: () => {},
    },
    null,
    (line) => {
      lines.push(line);

      // both snapshot lines are in, so impd's connection drops
      if (lines.length === 2) {
        void ctx.stopListener();
      }
    },
  );

  expect(printing).rejects.toThrow();

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    expect.objectContaining({
      ev: 'ImpAdded',
      imp: expect.objectContaining({ name: 'dev' }) as unknown,
    }),
    expect.objectContaining({
      ev: 'ImpAdded',
      imp: expect.objectContaining({ name: 'web' }) as unknown,
    }),
  ]);
});

test('it starts the count and the backoff again after a stream that lasted', async () => {
  const ctx = await setupTest();

  await ctx.stopListener();

  const live = createImpClient({ url: ctx.url, token: ctx.rootToken });

  // impd is back for the third try
  const backoff = buildStubBackoffClock({
    at: 2,
    onWait: () => {
      ctx.startListener();
    },
  });

  const printing = printEvents(
    {
      events: {
        stream: async () => {
          const stream = await live.events.stream();

          // the stream that opens lasts 20 s, then impd's connection drops
          backoff.advance(20_000);
          void ctx.stopListener();

          return stream;
        },
      },
      checkServer: () => live.checkServer(),
      now: backoff.now,
      wait: backoff.wait,
      warn: () => {},
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: Unable to connect. Is the computer able to access the url?',
  );

  expect(backoff.delays).toStrictEqual([1000, 2000, 1000, 2000, 4000, 8000]);
});

test('it reconnects after impd fails the stream with a server error', async () => {
  const ctx = await setupTest();

  // the snapshot read fails on a closed database, as on a failed disk
  await ctx.db.destroy();

  const warn = mock<(line: string) => void>();

  const printing = printEvents(
    {
      events: ctx.client.events,
      checkServer: () => ctx.client.checkServer(),
      now: Date.now,
      wait: () => Promise.resolve(),
      warn,
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: Internal server error',
  );

  expect(warn.mock.calls[0]).toStrictEqual([
    'impz: the event stream ended (Internal server error); reconnecting in 1000ms',
  ]);
});

test('it rethrows impd’s refusal of a token it does not know, without retrying', async () => {
  const ctx = await setupTest();

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: ctx.sendRequest,
  });

  const wait = mock<(durationMs: number) => Promise<void>>(() => Promise.resolve());

  const printing = printEvents(
    {
      events: stranger.events,
      checkServer: () => stranger.checkServer(),
      now: Date.now,
      wait,
      warn: () => {},
    },
    null,
    () => {},
  );

  expect(printing).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  expect(wait).not.toHaveBeenCalled();
});

test('it says to upgrade an impd that has no stream procedure, without retrying', async () => {
  const ctx = await setupTest();

  // impd answers the procedure an older release lacked with its own
  // plain-text not-found
  const older = createImpClient({
    url: 'http://impd.test',
    token: ctx.rootToken,
    fetch: buildStubImpdReleaseFetch(ctx.sendRequest, { withoutProcedures: ['events/stream'] })
      .fetch,
  });

  const info = await ctx.client.system.info();

  const wait = mock<(durationMs: number) => Promise<void>>(() => Promise.resolve());
  const warn = mock<(line: string) => void>();

  const printing = printEvents(
    {
      events: older.events,
      checkServer: () => older.checkServer(),
      now: Date.now,
      wait,
      warn,
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    `impd ${info.version} has no event stream; upgrade it to ${CLIENT_VERSION}`,
  );

  expect(wait).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

// no impd sends this, as the test above shows; its input is the NOT_FOUND an
// oRPC router sends for a procedure it does not have
test('it says to upgrade an impd that answers NOT_FOUND for the stream', () => {
  const printing = printEvents(
    {
      events: { stream: () => Promise.reject(new ORPCError('NOT_FOUND', { status: 404 })) },
      checkServer: () =>
        Promise.resolve({ clientVersion: '0.3.0', serverVersion: '0.2.2', compatible: false }),
      now: Date.now,
      wait: () => Promise.resolve(),
      warn: () => {},
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'impd 0.2.2 has no event stream; upgrade it to 0.3.0',
  );
});
