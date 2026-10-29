import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MoveState } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockMoveTicketRow } from '../../../testing/imp-ops/build-mock-move-ticket-row';
import { buildStubOverlappingMove } from '../../../testing/imp-ops/build-stub-overlapping-move';
import {
  SOURCE_PEER,
  TARGET_URL,
  createUbuntuImage,
  createZfsUbuntuImage,
  setupMoveHosts,
} from '../../../testing/imp-ops/create-move-hosts';
import type { MoveHostsOptions } from '../../../testing/imp-ops/create-move-hosts';
import { makeStubDroppedCommit } from '../../../testing/imp-ops/make-stub-dropped-commit';
import {
  buildJsonMoveFrame,
  makeStubMoveStreamRewrite,
} from '../../../testing/imp-ops/make-stub-move-stream-rewrite';
import { makeStubOlderMoveTarget } from '../../../testing/imp-ops/make-stub-older-move-target';
import { makeStubSwitchedStorageTarget } from '../../../testing/imp-ops/make-stub-switched-storage-target';
import { buildStubTailscale } from '../../../testing/network/build-stub-tailscale';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { runSql } from '../../../testing/platform/run-sql';
import { TEST_TOKEN } from '../../../testing/test-token';
import { buildStubPublishHook } from '../../../testing/vm/build-stub-publish-hook';
import { buildStubStorageFaults } from '../../../testing/vm/build-stub-storage-faults';
import { buildStubStoragePressure } from '../../../testing/vm/build-stub-storage-pressure';
import { buildStubZfsStorage } from '../../../testing/vm/build-stub-zfs-storage';
import { listImages, readImageByDigest, readImageByName } from '../../platform/db/images';
import type { ImpWrite } from '../../platform/db/imp-write-feed';
import { listImps, readImpByName, updateImpExposure, updateImpMove } from '../../platform/db/imps';
import { readMoveSend, updateMoveSendStep } from '../../platform/db/move-sends';
import { listMoveTickets } from '../../platform/db/move-tickets';
import { MOVE_TRANSITIONS } from '../../platform/db/move-transitions';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { FileEndSchema, MOVE_FRAMES, MoveFileSchema, readJsonPayload } from './move-frames';
import { MOVE_FINISH_HEADER, MOVE_PART_HEADER, MoveHeaderSchema } from './move-header';
import {
  ReceiptSchema,
  buildReceipt,
  buildTicketHeader,
  readReceipt,
  readTicketHeader,
} from './move-tickets';

function setupTest(config: Readonly<MoveHostsOptions> = {}) {
  return setupMoveHosts(config);
}

test('it moves a stopped imp with its id, its checkpoint and its disk', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'hello');

  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'world');

  const status = await ctx.runMove('dev');
  const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
  const left = await readImpByName(ctx.source.db, 'dev');

  invariant(checkpoints[0]);

  const impDir = join(ctx.target.dataDir, 'imps', created.id);
  const disk = readFileSync(join(impDir, 'disk.ext4'), 'utf8');

  const checkpointDisk = readFileSync(
    join(impDir, 'checkpoints', checkpoints[0].id, 'disk.ext4'),
    'utf8',
  );

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ id: created.id, state: 'stopped' });
  expect(moved.move).toBeUndefined();
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one']);
  expect(disk).toStartWith('world');
  expect(checkpointDisk).toStartWith('hello');
  expect(left).toBeUndefined();
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it logs a finished move under move with the imp and the target', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const lines = captureImpdLogs();

  await ctx.runMove('dev');

  expect(lines).toContain(
    'INFO impd.move imp=dev committed on http://100.100.0.2:7070; the copy here is gone',
  );

  expect(lines).toContain('INFO impd.move imp=dev committed; it lives here now');
});

test('it refuses a start of a marked imp with MOVING and a retry after 30 s', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.imps.start({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
    data: { retryAfterS: 30 },
  });
});

test('it refuses a destroy of a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.imps.destroy({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
    data: { retryAfterS: 30 },
  });
});

test('it refuses a disk resize of a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(
    ctx.sourceApp.client.imps.resizeDisk({ name: 'dev', diskMib: 2048 }),
  ).rejects.toMatchObject({ code: 'MOVING', status: 409, data: { retryAfterS: 30 } });
});

test('it refuses a checkpoint of a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.checkpoints.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
    data: { retryAfterS: 30 },
  });
});

test('it answers a raw start of a marked imp with 409 and a Retry-After header', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const raw = await ctx.source.impd.api.app.handle(
    new Request('http://impd.test/rpc/imps/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'dev' } }),
    }),
  );

  expect(raw.status).toBe(409);
  expect(raw.headers.get('retry-after')).toBe('30');
});

test('it lists a prepared imp as sending', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const listed = await ctx.sourceApp.client.imps.get({ name: 'dev' });

  expect(listed.move).toBe('sending');
});

test('it lets an imp start again once an abort before the stream undoes its mark', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const started = await ctx.sourceApp.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');
  expect(ctx.commits).toStrictEqual([]);
});

test('it refuses to move a public imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await updateImpExposure(ctx.source.db, created.id, { auth: 'none', user: null, hash: null });

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('it refuses an unexpose of a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.imps.unexpose({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it writes no exposure change to a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const written = await updateImpExposure(ctx.source.db, created.id, {
    auth: 'none',
    user: null,
    hash: null,
  });

  expect(written).toBeUndefined();
});

test('it refuses to move a running imp without stop', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it stops a running imp that a prepare with stop marks', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true });

  const imp = await ctx.sourceApp.client.imps.get({ name: 'dev' });

  expect(imp).toMatchObject({ state: 'stopped', move: 'sending' });
});

test('it leaves the source unmarked and the target empty when the receipt is not signed with the ticket', async () => {
  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      if (request.headers.get(MOVE_FINISH_HEADER) !== '1') {
        return response;
      }

      const answer: unknown = await response.json();

      const receipt = ReceiptSchema.parse(answer);

      return Response.json({ ...receipt, mac: '00'.repeat(32) });
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const lines = captureImpdLogs();

  const status = await ctx.runMove('dev');
  const source = await readImpByName(ctx.source.db, 'dev');
  const target = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the receipt is not signed with this ticket');
  expect(source?.moveState).toBeNull();
  expect(target).toBeUndefined();
  expect(lines).toContain('INFO impd.move imp=dev aborted by the source');
});

test('it logs a staged imp on the target that the abort of a failed receive cannot remove', async () => {
  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      if (request.headers.get(MOVE_FINISH_HEADER) !== '1') {
        return response;
      }

      const answer: unknown = await response.json();

      const receipt = ReceiptSchema.parse(answer);

      return Response.json({ ...receipt, mac: '00'.repeat(32) });
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await runSql(
    ctx.target.db,
    `CREATE TRIGGER keep_imps BEFORE DELETE ON imps
    BEGIN SELECT RAISE(ABORT, 'imp rows kept'); END`,
  );

  const lines = captureImpdLogs();

  await ctx.runMove('dev');

  expect(lines).toContain('WARNING impd.move imp=dev a failed receive left the imp: imp rows kept');
});

test('it leaves the source unmarked when a signed receipt does not match what was sent', async () => {
  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      const secret = readTicketHeader(request)?.secret;

      if (request.headers.get(MOVE_FINISH_HEADER) !== '1' || secret === undefined) {
        return response;
      }

      const answer: unknown = await response.json();

      const body = readReceipt(ReceiptSchema.parse(answer), secret);

      invariant(body);

      const files = body.files.map((file) => ({ ...file, sha256: '0'.repeat(64) }));

      return Response.json(buildReceipt({ ...body, files }, secret));
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('the receipt does not match what was sent');
  expect(source?.moveState).toBeNull();
});

test('it records no received digest for a sent image when the receipt does not match what was sent', async () => {
  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      const secret = readTicketHeader(request)?.secret;

      if (request.headers.get(MOVE_FINISH_HEADER) !== '1' || secret === undefined) {
        return response;
      }

      const answer: unknown = await response.json();

      const body = readReceipt(ReceiptSchema.parse(answer), secret);

      invariant(body);

      const files = body.files.map((file) => ({ ...file, sha256: '0'.repeat(64) }));

      return Response.json(buildReceipt({ ...body, files }, secret));
    },
  });

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const sent = await readImageByName(ctx.target.db, 'ubuntu');
  const image = await readImageByName(ctx.source.db, 'ubuntu');

  invariant(image);

  expect(status.error).toContain('the receipt does not match what was sent');
  expect(sent).toBeDefined();
  expect(image.receivedDigest).toBeNull();
});

test('it ends a send to a target that is gone with the mark on, and says the abort went unconfirmed', async () => {
  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith('/move/receive') || request.url.endsWith('/move/abort')) {
        return Promise.reject(new TypeError('Unable to connect'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(status.state).toBe('sending');
  expect(status.error).toContain('the target did not confirm the abort');
  expect(source?.moveState).toBe('sending');
});

test('it ends a move whose target sends no answer to a part within an hour', async () => {
  const clock = buildStubClock();
  const partHeld = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    startPeerDeadline: clock.startTimer,

    hook: (request, forward) => {
      if (request.headers.get(MOVE_PART_HEADER) !== '0') {
        return forward();
      }

      const aborted = Promise.withResolvers<Response>();

      request.signal.addEventListener('abort', () => {
        aborted.reject(request.signal.reason);
      });

      partHeld.resolve(undefined);

      return aborted.promise;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const moved = ctx.runMove('dev');

  await partHeld.promise;

  const pendingMs = clock.readPendingMs();

  clock.firePending();

  const status = await moved;

  expect(pendingMs).toStrictEqual([3_600_000]);
  expect(status.error).toContain('/move/receive: the target sent no answer in 60 minutes');
});

test('it ends a move whose target sends no answer to the finish within an hour', async () => {
  const clock = buildStubClock();
  const finishHeld = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    startPeerDeadline: clock.startTimer,

    hook: (request, forward) => {
      if (request.headers.get(MOVE_FINISH_HEADER) !== '1') {
        return forward();
      }

      const aborted = Promise.withResolvers<Response>();

      request.signal.addEventListener('abort', () => {
        aborted.reject(request.signal.reason);
      });

      finishHeld.resolve(undefined);

      return aborted.promise;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const moved = ctx.runMove('dev');

  await finishHeld.promise;

  const pendingMs = clock.readPendingMs();

  clock.firePending();

  const status = await moved;

  expect(pendingMs).toStrictEqual([3_600_000]);
  expect(status.error).toContain('/move/receive: the target sent no answer in 60 minutes');
});

test('it keeps both copies when the target sends no answer to the commit within ten minutes', async () => {
  const clock = buildStubClock();
  const commitHeld = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    startPeerDeadline: clock.startTimer,

    hook: (request, forward) => {
      if (!request.url.endsWith('/move/commit')) {
        return forward();
      }

      const aborted = Promise.withResolvers<Response>();

      request.signal.addEventListener('abort', () => {
        aborted.reject(request.signal.reason);
      });

      commitHeld.resolve(undefined);

      return aborted.promise;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const moved = ctx.runMove('dev');

  await commitHeld.promise;

  const pendingMs = clock.readPendingMs();

  clock.firePending();

  const status = await moved;
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(pendingMs).toStrictEqual([600_000]);
  expect(status.error).toContain('/move/commit: the target sent no answer in 10 minutes');
  expect(source?.moveState).toBe('moved');
});

test('it ends a move whose target sends no answer to the offer within ten minutes', async () => {
  const clock = buildStubClock();
  const offerHeld = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    startPeerDeadline: clock.startTimer,

    hook: (request, forward) => {
      if (!request.url.endsWith('/move/offer')) {
        return forward();
      }

      const aborted = Promise.withResolvers<Response>();

      request.signal.addEventListener('abort', () => {
        aborted.reject(request.signal.reason);
      });

      offerHeld.resolve(undefined);

      return aborted.promise;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const moved = ctx.runMove('dev');

  await offerHeld.promise;

  const pendingMs = clock.readPendingMs();

  clock.firePending();

  const status = await moved;

  expect(pendingMs).toStrictEqual([600_000]);
  expect(status.error).toContain('/move/offer: the target sent no answer in 10 minutes');
});

test('it keeps the mark when the target sends no answer to the abort within ten minutes', async () => {
  const clock = buildStubClock();
  const abortHeld = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    startPeerDeadline: clock.startTimer,

    hook: (request, forward) => {
      if (request.url.endsWith('/move/receive')) {
        return Promise.reject(new TypeError('Unable to connect'));
      }

      if (!request.url.endsWith('/move/abort')) {
        return forward();
      }

      const aborted = Promise.withResolvers<Response>();

      request.signal.addEventListener('abort', () => {
        aborted.reject(request.signal.reason);
      });

      abortHeld.resolve(undefined);

      return aborted.promise;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const moved = ctx.runMove('dev');

  await abortHeld.promise;

  const pendingMs = clock.readPendingMs();

  clock.firePending();

  const status = await moved;
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(pendingMs).toStrictEqual([600_000]);
  expect(status.error).toContain('the target did not confirm the abort');
  expect(source?.moveState).toBe('sending');
});

test('it reports no error for a failed send while its abort still goes', async () => {
  const abortReached = Promise.withResolvers<undefined>();
  const abortRelease = Promise.withResolvers<undefined>();
  const sendEnded = { wait: (): Promise<unknown> => Promise.resolve() };

  onTestFinished(() => {
    abortRelease.resolve(undefined);

    return sendEnded.wait();
  });

  const ctx = await setupTest({
    hook: async (request, forward) => {
      if (request.url.endsWith('/move/abort')) {
        abortReached.resolve(undefined);

        await abortRelease.promise;

        throw new TypeError('Unable to connect');
      }

      if (request.url.endsWith('/move/receive')) {
        throw new TypeError('Unable to connect');
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 * 1024 });

  await ctx.sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  sendEnded.wait = () => ctx.waitForMove('dev');

  await abortReached.promise;

  const during = await ctx.sourceApp.client.moves.status({ name: 'dev' });

  expect(during).toMatchObject({ isDone: false, error: null });
});

test('it keeps both copies marked when the commit is lost after the receipt', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await readImpByName(ctx.source.db, 'dev');
  const target = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('dropped the commit');
  expect(source?.moveState).toBe('moved');
  expect(target?.moveState).toBe('receiving');
});

test('it refuses a start on the target of a copy whose commit was lost', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  expect(ctx.targetApp.client.imps.start({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it commits on resume after a lost commit, and the source copy goes', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');
  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev' });
  const source = await readImpByName(ctx.source.db, 'dev');
  const target = await readImpByName(ctx.target.db, 'dev');

  expect(failed.error).toContain('dropped the commit');
  expect(resumed.isDone).toBe(true);
  expect(source).toBeUndefined();
  expect(target?.moveState).toBeNull();
});

test.each([
  ['request', 'dropped the commit'],
  ['answer', 'dropped the answer'],
] as const)(
  'it commits once after a restart between the stored receipt and the move mark, with the %s lost',
  async (drops, dropped) => {
    const ctx = await setupTest({ hook: makeStubDroppedCommit({ drops }) });

    await createUbuntuImage(ctx.source);
    await createUbuntuImage(ctx.target);

    const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

    await ctx.sourceApp.client.imps.stop({ name: 'dev' });

    const failed = await ctx.runMove('dev');
    const send = await readMoveSend(ctx.source.db, created.id);

    await ctx.source.db
      .updateTable('imps')
      .set({ move_state: 'sending' })
      .where('id', '=', created.id)
      .execute();

    await ctx.source.restartImpd();
    await ctx.source.moves.waitForRecovery();

    const source = await readImpByName(ctx.source.db, 'dev');
    const target = await readImpByName(ctx.target.db, 'dev');

    expect(failed.error).toContain(dropped);
    expect(send?.step).toBe('sent');
    expect(source).toBeUndefined();
    expect(target?.moveState).toBeNull();
    expect(ctx.commits).toStrictEqual(['dev']);
  },
);

test('it reports the commit on the target once when a commit whose answer was lost resumes', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit({ drops: 'answer' }) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');
  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev' });

  expect(failed.error).toContain('dropped the answer');
  expect(resumed.isDone).toBe(true);
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it destroys the source copy on an abort after the target committed', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit({ drops: 'answer' }) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');
  const aborted = await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  const source = await readImpByName(ctx.source.db, 'dev');
  const target = await ctx.targetApp.client.imps.get({ name: 'dev' });

  expect(failed.error).toContain('dropped the answer');
  expect(aborted.isDone).toBe(true);
  expect(source).toBeUndefined();
  expect(target.move).toBeUndefined();
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it refuses a ticket in the URL in place of the header', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive?ticket=${ticket.ticket}`, {
      method: 'POST',
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(401);

  expect(body).toStrictEqual({
    defined: false,
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'no move ticket in the Authorization header',
    error: 'no move ticket in the Authorization header',
  });
});

test.each([
  ['{id}.not-the-secret', 'unknown move ticket'],
  ['not-the-id.{secret}', 'unknown move ticket'],
  ['{id}.{secret}.more', 'no move ticket in the Authorization header'],
  ['{id}', 'no move ticket in the Authorization header'],
  ['{id}.', 'no move ticket in the Authorization header'],
  ['.{secret}', 'no move ticket in the Authorization header'],
])('it refuses the forged ticket %s with %p', async (template, error) => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const [id = '', secret = ''] = ticket.ticket.split('.');
  const forged = template.replace('{id}', id).replace('{secret}', secret);

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: buildTicketHeader(forged),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(401);

  expect(body).toStrictEqual({
    defined: false,
    code: 'UNAUTHORIZED',
    status: 401,
    message: error,
    error,
  });
});

test('it refuses a stream from off the tailnet', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    '192.168.1.5',
  );

  expect(response.status).toBe(403);
});

test('it takes the first part of a stream from the tailnet', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  expect(response.status).toBe(202);
});

test('it refuses a second stream on a ticket', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const second = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await second.json();

  expect(second.status).toBe(409);

  expect(body).toStrictEqual({
    defined: false,
    code: 'CONFLICT',
    status: 409,
    message: 'the move ticket was used for a stream already',
    error: 'the move ticket was used for a stream already',
  });
});

test('it refuses a part that comes before the first', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: { ...buildTicketHeader(ticket.ticket), [MOVE_PART_HEADER]: '1' },
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);

  expect(body).toStrictEqual({
    defined: false,
    code: 'CONFLICT',
    status: 409,
    message: 'part 1 is out of order',
    error: 'part 1 is out of order',
  });
});

test('it refuses a finish for a ticket with no stream', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: { ...buildTicketHeader(ticket.ticket), [MOVE_FINISH_HEADER]: '1' },
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);

  expect(body).toStrictEqual({
    defined: false,
    code: 'CONFLICT',
    status: 409,
    message: 'no stream to finish for this ticket',
    error: 'no stream to finish for this ticket',
  });
});

test('it refuses a commit for a ticket with no receipt', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/commit`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);

  expect(body).toStrictEqual({
    defined: false,
    code: 'CONFLICT',
    status: 409,
    message: 'nothing to commit: no receipt for this ticket',
    error: 'nothing to commit: no receipt for this ticket',
  });
});

test('it refuses a ticket for a name the target has', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.target);

  await ctx.targetApp.client.imps.create({ name: 'taken', image: 'ubuntu' });

  expect(ctx.targetApp.client.moves.receive({ name: 'taken', bytes: 1 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a stream that starts past its ticket window', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1 });

  ctx.target.advance(11 * 60 * 1000);

  const late = await ctx.target.moves.respond(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([1]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await late.json();

  expect(late.status).toBe(410);

  expect(body).toStrictEqual({
    defined: false,
    code: 'GONE',
    status: 410,
    message: 'the move ticket expired before its stream started',
    error: 'the move ticket expired before its stream started',
  });
});

test('it cuts off a stream longer than its ticket and leaves nothing on the target', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 3 });

  await ctx.sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await ctx.waitForMove('dev');
  const target = await readImpByName(ctx.target.db, 'dev');
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('the stream is longer than its ticket allows');
  expect(target).toBeUndefined();
  expect(source?.moveState).toBeNull();
});

test('it refuses a peer URL off the tailnet before any byte goes', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(
    ctx.sourceApp.client.moves.send({ name: 'dev', to: 'http://192.168.1.5:7070', ticket: 'a.b' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a peer URL that names a host before any byte goes', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(
    ctx.sourceApp.client.moves.send({ name: 'dev', to: 'http://imp-b:7070', ticket: 'a.b' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it files the image a target lacks under the digest of what arrived', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const image = await readImageByName(ctx.target.db, 'ubuntu');

  invariant(image);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(image.digest).toStartWith('sha256:');
  expect(image.digest).not.toBe('sha256:ubuntu');

  const hex = image.digest.slice('sha256:'.length);
  const rootfs = readFileSync(join(ctx.target.dataDir, 'images', hex, 'rootfs.ext4'));

  expect(rootfs.toString()).toStartWith('rootfs');
});

test('it sends no image on a move back to a host that holds it, and the imp keeps its image row there', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const original = await readImageByName(ctx.source.db, 'ubuntu');

  invariant(original);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const status = await ctx.runMoveBack('dev');
  const tickets = await listMoveTickets(ctx.source.db);
  const back = await readImpByName(ctx.source.db, 'dev');
  const images = await listImages(ctx.source.db);

  const text = tickets[0]?.receipt;

  invariant(typeof text === 'string');

  const receipt = ReceiptSchema.parse(JSON.parse(text));

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(JSON.parse(receipt.body)).toMatchObject({ files: [{ kind: 'disk' }] });
  expect(back?.imageId).toBe(original.id);
  expect(images.map((image) => image.name)).toStrictEqual(['ubuntu']);
});

test('it files an image whose rootfs ends in zero blocks under one digest on every hop', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  writeFileSync(
    buildImagePaths(ctx.source.dataDir, 'sha256:ubuntu').rootfs,
    Buffer.concat([Buffer.from('rootfs'), Buffer.alloc(3 * 1024 * 1024 - 6)]),
  );

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.sourceApp.client.images.delete({ name: 'ubuntu' });

  const status = await ctx.runMoveBack('dev');
  const there = await readImageByName(ctx.target.db, 'ubuntu');
  const back = await readImageByName(ctx.source.db, 'ubuntu');

  invariant(there);
  invariant(back);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(back.digest).toBe(there.digest);
});

test('it files a received image under the digest of what arrived, whatever digests the source claims', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, {
          ...header,
          image: { ...header.image, digest: 'sha256:pulled', receivedDigest: 'sha256:claimed' },
        });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const image = await readImageByName(ctx.target.db, 'ubuntu');
  const claimed = await readImageByDigest(ctx.target.db, ['sha256:pulled', 'sha256:claimed']);

  invariant(image);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(claimed).toBeUndefined();
  expect(image.receivedDigest).toBeNull();
});

test('it lands a moved imp with the digest it cloned from', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await runSql(ctx.source.db, 'UPDATE imps SET image_digest = ? WHERE id = ?', [
    'sha256:older',
    created.id,
  ]);

  const status = await ctx.runMove('dev');
  const landed = await readImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(landed?.imageDigest).toBe('sha256:older');
});

test('it lands an imp from a source that sends no cloned digest with its image’s digest', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));
        const { clonedDigest: _dropped, ...imp } = header.imp;

        return buildJsonMoveFrame(frame.type, { ...header, imp });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await runSql(ctx.source.db, 'UPDATE imps SET image_digest = ? WHERE id = ?', [
    'sha256:older',
    created.id,
  ]);

  const status = await ctx.runMove('dev');
  const landed = await readImpByName(ctx.target.db, 'dev');
  const image = await readImageByName(ctx.target.db, 'ubuntu');

  invariant(image);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(landed?.imageDigest).toBe(image.digest);
});

test('it reads the image a move sends when an overlapping move installs that image first', async () => {
  const overlap = buildStubOverlappingMove();

  const ctx = await setupTest({ hook: overlap.hook });

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'zero', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.create({ name: 'one', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.create({ name: 'two', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'zero' });
  await ctx.sourceApp.client.imps.stop({ name: 'one' });
  await ctx.sourceApp.client.imps.stop({ name: 'two' });
  await ctx.runMove('zero');
  await ctx.targetApp.client.imps.destroy({ name: 'zero' });
  await ctx.targetApp.client.images.delete({ name: 'ubuntu' });

  overlap.arm(() => ctx.runMove('two'));

  const status = await ctx.runMove('one');
  const one = await readImpByName(ctx.target.db, 'one');
  const two = await readImpByName(ctx.target.db, 'two');
  const images = await listImages(ctx.target.db);

  invariant(one);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(two?.imageId).toBe(one.imageId);
  expect(images.map((image) => image.name)).toStrictEqual(['ubuntu']);
});

test('it refuses a data frame that goes back over the data before it', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.flatMap((frame, index) =>
        index === 2 && frame.type === MOVE_FRAMES.data ? [frame, frame] : [frame],
      ),
    ),
  });

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('image-rootfs: a DATA frame out of order');
});

test('it keeps an old image the target has by digest when an eviction reaches the stream as it picks the image', async () => {
  const gate = buildQueryGate('sha256:web-1111111');

  onTestFinished(() => {
    gate.release();
  });

  // the offer records a use too, so the image ages again between the offer and the stream
  const beforeStream = { run: (): Promise<unknown> => Promise.resolve() };

  const ctx = await setupTest({
    target: {
      wrapDatabase: gate.wrap,
      env: { IMP_IMAGE_EVICT_HIGH_PERCENT: '80', IMP_IMAGE_EVICT_LOW_PERCENT: '60' },
      createStorage: (dataDir) => ({
        ...createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ...buildStubStoragePressure({ usedBytes: 90, availableBytes: 10, freedBytes: 1 }),
      }),
    },
    hook: async (request, forward) => {
      if (new URL(request.url).pathname === '/move/receive') {
        await beforeStream.run();

        gate.arm();
      }

      return forward();
    },
  });

  beforeStream.run = () =>
    ctx.target.db
      .updateTable('images')
      .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
      .where('name', '=', 'web-1111111')
      .execute();

  await ctx.source.createTestImage('web-1111111');
  await ctx.target.createTestImage('web-1111111');

  writeFileSync(buildImagePaths(ctx.source.dataDir, 'sha256:web-1111111').config, '{}');

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'web-1111111' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const moving = ctx.runMove('dev');

  await gate.reached;

  await ctx.target.images.runImageEviction();

  gate.release();

  const status = await moving;
  const image = await readImageByName(ctx.target.db, 'web-1111111');
  const dev = await readImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(dev?.imageId).toBe(image?.id);
});

test('it keeps an old image the target has by digest when an eviction reaches the move as it offers the image', async () => {
  const gate = buildQueryGate('sha256:web-1111111');

  onTestFinished(() => {
    gate.release();
  });

  const ctx = await setupTest({
    target: {
      wrapDatabase: gate.wrap,
      env: { IMP_IMAGE_EVICT_HIGH_PERCENT: '80', IMP_IMAGE_EVICT_LOW_PERCENT: '60' },
      createStorage: (dataDir) => ({
        ...createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ...buildStubStoragePressure({ usedBytes: 90, availableBytes: 10, freedBytes: 1 }),
      }),
    },
  });

  await ctx.source.createTestImage('web-1111111');
  await ctx.target.createTestImage('web-1111111');

  writeFileSync(buildImagePaths(ctx.source.dataDir, 'sha256:web-1111111').config, '{}');

  await ctx.target.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'web-1111111')
    .execute();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'web-1111111' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  gate.arm();

  const moving = ctx.runMove('dev');

  await gate.reached;

  await ctx.target.images.runImageEviction();

  gate.release();

  const status = await moving;
  const image = await readImageByName(ctx.target.db, 'web-1111111');
  const dev = await readImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(dev?.imageId).toBe(image?.id);
});

test('it keeps an old image the target has under the digest of what arrived when an eviction reaches the move as it picks the image', async () => {
  const gate = buildQueryGate('sha256:web-1111111');

  onTestFinished(() => {
    gate.release();
  });

  const ctx = await setupTest({
    target: {
      wrapDatabase: gate.wrap,
      env: { IMP_IMAGE_EVICT_HIGH_PERCENT: '80', IMP_IMAGE_EVICT_LOW_PERCENT: '60' },
      createStorage: (dataDir) => ({
        ...createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ...buildStubStoragePressure({ usedBytes: 90, availableBytes: 10, freedBytes: 1 }),
      }),
    },
  });

  await ctx.source.createTestImage('web-1111111');

  writeFileSync(buildImagePaths(ctx.source.dataDir, 'sha256:web-1111111').config, '{}');

  await ctx.sourceApp.client.imps.create({ name: 'one', image: 'web-1111111' });
  await ctx.sourceApp.client.imps.stop({ name: 'one' });
  await ctx.runMove('one');
  await ctx.targetApp.client.imps.destroy({ name: 'one' });

  const filed = await readImageByName(ctx.target.db, 'web-1111111');

  invariant(filed);

  await ctx.target.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'web-1111111')
    .execute();

  await ctx.sourceApp.client.imps.create({ name: 'two', image: 'web-1111111' });
  await ctx.sourceApp.client.imps.stop({ name: 'two' });

  gate.arm(filed.digest);

  const moving = ctx.runMove('two');

  await gate.reached;

  await ctx.target.images.runImageEviction();

  gate.release();

  const status = await moving;
  const image = await readImageByName(ctx.target.db, 'web-1111111');
  const two = await readImpByName(ctx.target.db, 'two');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(two?.imageId).toBe(image?.id);
});

test('it keeps the rootfs a move publishes when the cleanup of an earlier removal of its digest runs before its row', async () => {
  const publish = buildStubPublishHook();

  const ctx = await setupTest({
    target: {
      createStorage: (dataDir) =>
        publish.wrap(
          createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ),
    },
  });

  await ctx.source.createTestImage('web-1111111');

  writeFileSync(buildImagePaths(ctx.source.dataDir, 'sha256:web-1111111').config, '{}');

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'web-1111111' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  publish.setAfterPublish(async (digest) => {
    await ctx.target.db.insertInto('image_removals').values({ digest, created_at: 0 }).execute();
    await ctx.target.images.runImageEviction();
  });

  const status = await ctx.runMove('dev');
  const image = await readImageByName(ctx.target.db, 'web-1111111');

  invariant(image);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(existsSync(buildImagePaths(ctx.target.dataDir, image.digest).rootfs)).toBeTrue();
});

test('it carries only the grants of secrets the target has', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.source.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_real' });
  await ctx.source.broker.addGrant('dev', 'gh');
  await ctx.source.broker.addGrant('dev', 'npm');
  await ctx.target.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_other' });

  const lines = captureImpdLogs();

  const status = await ctx.runMove('dev');
  const grants = await ctx.target.broker.listGrants('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(grants).toStrictEqual(['gh']);
  expect(lines).toContain('WARNING impd.move imp=dev grant npm not kept: secret npm not found');
});

test('it lands an imp without a grant the target cannot write, and logs the grant', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.source.broker.addGrant('dev', 'gh');
  await ctx.target.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_other' });

  await runSql(
    ctx.target.db,
    `CREATE TRIGGER refuse_grants BEFORE INSERT ON grants
    BEGIN SELECT RAISE(ABORT, 'grant rows refused'); END`,
  );

  const lines = captureImpdLogs();

  const status = await ctx.runMove('dev');
  const grants = await ctx.target.broker.listGrants('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(grants).toStrictEqual([]);
  expect(lines).toContain('WARNING impd.move imp=dev grant gh not kept: grant rows refused');
});

test('it lands an imp whose egress policy the target does not know with no egress', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, {
          ...header,
          imp: { ...header.imp, egress: { mode: 'tunnel', allow: [] } },
        });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const lines = captureImpdLogs();

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(lines).toContain(
    'WARNING impd.move imp=dev unknown egress policy "tunnel"; imported as none',
  );
});

test('it finishes a move whose source parts fail to close, and logs the close', async () => {
  const faults = buildStubStorageFaults();

  const ctx = await setupTest({
    source: {
      createStorage: (dataDir) =>
        faults.wrap(
          createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ),
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  faults.failOnce('closeMoveSource', new Error('the snapshot is busy'));

  const lines = captureImpdLogs();

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(lines).toContain(
    "WARNING impd.move imp=dev closing the source's parts failed: the snapshot is busy",
  );
});

test('it warns at boot that a test range opens moves off the tailnet', async () => {
  const lines = captureImpdLogs();

  await setupTest({ target: { env: { IMP_E2E: '1', IMP_MOVE_TEST_CIDR: '10.70.0.0/24' } } });

  expect(lines).toContain(
    'WARNING impd.move IMP_E2E=1 and IMP_MOVE_TEST_CIDR open moves to 10.70.0.0/24, off the tailnet',
  );
});

test('it carries each grant’s filter to the target', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.source.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_real' });
  await ctx.source.broker.addGrant('dev', 'gh', null, { methods: ['GET'], paths: ['/user'] });
  await ctx.source.broker.addGrant('dev', 'npm');
  await ctx.target.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_other' });
  await ctx.target.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_other' });

  const status = await ctx.runMove('dev');
  const grants = await ctx.target.broker.listGrantDetails('dev');

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(grants).toStrictEqual([
    { secret: 'gh', filter: { methods: ['GET'], paths: ['/user'] } },
    { secret: 'npm', filter: null },
  ]);
});

test('it keeps the owed identity reset of a template copy, and its template stays a template', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await ctx.source.db
    .updateTable('images')
    .set({ source: 'imp', source_imp: 'golden' })
    .where('name', '=', 'ubuntu')
    .execute();

  await ctx.source.db
    .updateTable('imps')
    .set({ identity_reset_pending: 1 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev');
  const image = await readImageByName(ctx.target.db, 'ubuntu');
  const moved = await readImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(image).toMatchObject({ source: 'imp', sourceImp: 'golden' });
  expect(moved?.isIdentityResetPending).toBe(true);
});

test('it keeps an imp created with backup off out of the target’s backups', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu', backup: false });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const moved = await readImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved?.isBackedUp).toBe(false);
});

test('it refuses an imp created with backup off a target that predates the setting, before any byte goes', async () => {
  const ctx = await setupTest({ hook: makeStubOlderMoveTarget('keepsBackupOff') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu', backup: false });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const landed = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('predates imps left out of backups');
  expect(status.sentBytes).toBe(0);
  expect(landed).toBeUndefined();
});

test('it refuses a public imp a target that predates the policy, before any byte goes', async () => {
  const ctx = await setupTest({ hook: makeStubOlderMoveTarget('keepsPublicEgress') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.setPolicy({
    name: 'dev',
    policy: { mode: 'public', allow: [] },
  });

  const status = await ctx.runMove('dev', true);
  const imp = await readImpByName(ctx.source.db, 'dev');
  const landed = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('predates the public egress policy');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('it lands a public imp public on a target that knows the policy', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.setPolicy({
    name: 'dev',
    policy: { mode: 'public', allow: [] },
  });

  const status = await ctx.runMove('dev', true);
  const policy = await ctx.target.egress.readPolicy('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(policy).toStrictEqual({ mode: 'public', allow: [] });
});

test('it keeps the max memory of an elastic imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev');
  const moved = await readImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('it refuses to move an elastic imp to a target that would drop its max memory', async () => {
  const ctx = await setupTest({ hook: makeStubOlderMoveTarget('keepsMaxMemory') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev');
  const landed = await readImpByName(ctx.target.db, 'dev');
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('predates elastic memory');
  expect(status.sentBytes).toBe(0);
  expect(source).toMatchObject({ state: 'stopped', moveState: null, maxMemoryMib: 1024 });
  expect(landed).toBeUndefined();
});

test('it starts a running elastic imp again that --stop halted when the target refuses its max memory', async () => {
  const ctx = await setupTest({ hook: makeStubOlderMoveTarget('keepsMaxMemory') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev', true);
  const source = await readImpByName(ctx.source.db, 'dev');
  const landed = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('predates elastic memory');
  expect(source).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('it logs a halted imp that does not start again when the target refuses its max memory', async () => {
  const ctx = await setupTest({ hook: makeStubOlderMoveTarget('keepsMaxMemory') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  ctx.source.fake.queue('boot', 'fail');

  const lines = captureImpdLogs();

  await ctx.runMove('dev', true);

  expect(lines).toContain(
    String.raw`WARNING impd.move imp=dev could not start it again: boot failed: no agent\nlog tail`,
  );
});

test('it keeps every file the send reads through a GC while the stream goes', async () => {
  const runs: (readonly unknown[])[] = [];

  const ctx = await setupTest({
    hook: async (request, forward, hosts) => {
      if (request.url.endsWith('/move/receive') && request.headers.get(MOVE_PART_HEADER) === '0') {
        const result = await hosts.sourceApp.client.system.gc({});

        runs.push(result.dropped);
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(runs).toStrictEqual([[]]);
});

test('it refuses a grant change to a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.source.broker.addGrant('dev', 'gh')).rejects.toMatchObject({ code: 'MOVING' });
});

test('it refuses an egress policy change to a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.source.egress.setPolicy('dev', { mode: 'none', allow: [] })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it keeps a prepared send through a restart, and the send after it moves the imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const lines = captureImpdLogs();

  await ctx.source.restartImpd();
  await ctx.source.moves.waitForRecovery();

  const kept = await readImpByName(ctx.source.db, 'dev');
  const ticket = await ctx.target.client.moves.receive({ name: 'dev', bytes: plan.bytes });

  await ctx.source.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await ctx.waitForMove('dev');
  const landed = await readImpByName(ctx.target.db, 'dev');

  expect(kept?.moveState).toBe('sending');

  expect(lines).toContain(
    'INFO impd.move imp=dev a prepared send waits for its send after a restart',
  );

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(landed?.moveState).toBeNull();
});

test('it starts a halted imp again when the target refuses the send that comes after a restart', async () => {
  const ctx = await setupTest({ hook: makeStubOlderMoveTarget('keepsMaxMemory') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const plan = await ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true, force: true });

  await ctx.source.restartImpd();
  await ctx.source.moves.waitForRecovery();

  const ticket = await ctx.target.client.moves.receive({ name: 'dev', bytes: plan.bytes });

  await ctx.source.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await ctx.waitForMove('dev');
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('predates elastic memory');
  expect(source).toMatchObject({ state: 'running', moveState: null });
});

test('it undoes on restart a send cut short in its stream', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes });

  await updateMoveSendStep(ctx.source.db, created.id, 'streaming', {
    peer_url: ticket.peerUrl,
    ticket: ticket.ticket,
  });

  const lines = captureImpdLogs();

  await ctx.source.restartImpd();
  await ctx.source.moves.waitForRecovery();

  const undone = await readImpByName(ctx.source.db, 'dev');

  expect(undone?.moveState).toBeNull();
  expect(lines).toContain('INFO impd.move imp=dev a send cut short by a restart was undone');
});

test('it logs a recovery after a restart that cannot undo a send cut short', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes });

  await updateMoveSendStep(ctx.source.db, created.id, 'streaming', {
    peer_url: ticket.peerUrl,
    ticket: ticket.ticket,
  });

  await runSql(
    ctx.source.db,
    `CREATE TRIGGER keep_marks BEFORE UPDATE OF move_state ON imps
    BEGIN SELECT RAISE(ABORT, 'move marks kept'); END`,
  );

  const lines = captureImpdLogs();

  await ctx.source.moves.recover();
  await ctx.source.moves.waitForRecovery();

  const kept = await readImpByName(ctx.source.db, 'dev');

  expect(kept?.moveState).toBe('sending');
  expect(lines).toContain('WARNING impd.move recovery after a restart failed: move marks kept');
});

test('it logs a commit on restart that the target refuses, and the source keeps its copy', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.target.imps.destroyImp('dev', { isMove: true });

  const lines = captureImpdLogs();

  await ctx.source.moves.recover();
  await ctx.source.moves.waitForRecovery();

  const kept = await readImpByName(ctx.source.db, 'dev');

  expect(kept?.moveState).toBe('moved');

  expect(lines).toContain(
    'WARNING impd.move imp=dev commit after restart: commit: the target answered 409 nothing to commit: the received copy is gone',
  );
});

test('it commits a move whose tailnet name release fails, and logs the release', async () => {
  const tailscale = buildStubTailscale();

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.headers.get(MOVE_FINISH_HEADER) === '1') {
        tailscale.failNextStatus(new Error('tailscaled is down'));
      }

      return forward();
    },
    source: {
      env: { IMP_TAILNET_NAMES: '1', IMP_TAILSCALE_NODE: '1' },
      boundaries: { readTailscale: tailscale.readTailscale },
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const lines = captureImpdLogs();

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(lines).toContain(
    'WARNING impd.move imp=dev tailnet name not released yet: tailscaled is down',
  );
});

test('it finishes on restart a send the target has verified', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');

  await ctx.source.moves.recover();

  await waitFor(async () => {
    const imp = await readImpByName(ctx.source.db, 'dev');

    if (imp !== undefined) {
      throw new Error('the source copy is still here');
    }
  });

  const live = await ctx.targetApp.client.imps.get({ name: 'dev' });

  expect(failed.error).toContain('dropped the commit');
  expect(live.move).toBeUndefined();
});

test('it removes on a target restart a stream cut short and tickets never used', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.target);

  const staged = await ctx.target.imps.createImp({
    name: 'half',
    image: 'ubuntu',
    moveState: 'receiving',
  });

  const now = ctx.target.now();

  await ctx.target.db
    .insertInto('move_tickets')
    .values(
      buildMockMoveTicketRow({
        name: 'half',
        imp_id: staged.id,
        issued_at: now,
        stream_by: now + 1000,
        stream_used_at: now,
      }),
    )
    .execute();

  await ctx.targetApp.client.moves.receive({ name: 'later', bytes: 1 });

  ctx.target.advance(11 * 60 * 1000);

  await ctx.target.moves.recover();

  const rows = await ctx.target.db.selectFrom('move_tickets').select('id').execute();
  const gone = await readImpByName(ctx.target.db, 'half');

  expect(gone).toBeUndefined();
  expect(rows).toStrictEqual([]);
});

test('it counts a target that holds the imp unmarked as committed', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  await updateImpMove(ctx.target.db, created.id, null);

  const aborted = await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  const gone = await readImpByName(ctx.source.db, 'dev');

  expect(aborted.isDone).toBe(true);
  expect(gone).toBeUndefined();
});

test('it refuses a resume whose received copy is gone, and the source keeps its copy', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.target.imps.destroyImp('dev', { isMove: true });

  expect(ctx.sourceApp.client.moves.resume({ name: 'dev' })).rejects.toMatchObject({
    code: 'BAD_GATEWAY',
    message: 'commit: the target answered 409 nothing to commit: the received copy is gone',
  });

  const kept = await readImpByName(ctx.source.db, 'dev');

  expect(kept?.moveState).toBe('moved');
});

test('it refuses a resume past the commit window, and the source keeps its copy', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  ctx.target.advance(24 * 60 * 60 * 1000 + 60_000);

  expect(ctx.sourceApp.client.moves.resume({ name: 'dev' })).rejects.toMatchObject({
    code: 'BAD_GATEWAY',
    message: 'commit: the target answered 410 the commit window ended; reissue the ticket',
  });

  const kept = await readImpByName(ctx.source.db, 'dev');

  expect(kept?.moveState).toBe('moved');
});

test('it fails a send whose target answers the commit as not committed', async () => {
  const ctx = await setupTest({
    hook: (request, forward) =>
      request.url.endsWith('/move/commit')
        ? Promise.resolve(Response.json({ isCommitted: false }))
        : forward(),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await readImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('commit: the target did not commit');
  expect(source?.moveState).toBe('moved');
});

test('it moves the imp to the target when its commit lands before a racing abort', async () => {
  const dropped = makeStubDroppedCommit();
  const committed = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    hook: async (request, forward, hosts) => {
      if (request.url.endsWith('/move/abort')) {
        await committed.promise;
      }

      const response = await dropped(request, forward, hosts);

      if (request.url.endsWith('/move/commit')) {
        committed.resolve(undefined);
      }

      return response;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const settled = await Promise.allSettled([
    ctx.sourceApp.client.moves.abort({ name: 'dev' }),
    ctx.sourceApp.client.moves.resume({ name: 'dev' }),
  ]);

  const source = await readImpByName(ctx.source.db, 'dev');
  const target = await readImpByName(ctx.target.db, 'dev');

  expect(settled.map((result) => result.status)).toStrictEqual(['fulfilled', 'fulfilled']);
  expect(source).toBeUndefined();
  expect(target?.moveState).toBeNull();
});

test('it keeps the imp on the source when a racing abort reaches the target before the commit', async () => {
  const dropped = makeStubDroppedCommit();
  const aborted = Promise.withResolvers<undefined>();
  const commits = { sent: 0 };

  const ctx = await setupTest({
    hook: async (request, forward, hosts) => {
      if (request.url.endsWith('/move/commit')) {
        commits.sent += 1;
      }

      if (request.url.endsWith('/move/commit') && commits.sent > 1) {
        await aborted.promise;
      }

      const response = await dropped(request, forward, hosts);

      if (request.url.endsWith('/move/abort')) {
        aborted.resolve(undefined);
      }

      return response;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const settled = await Promise.allSettled([
    ctx.sourceApp.client.moves.resume({ name: 'dev' }),
    ctx.sourceApp.client.moves.abort({ name: 'dev' }),
  ]);

  const source = await readImpByName(ctx.source.db, 'dev');
  const target = await readImpByName(ctx.target.db, 'dev');

  expect(settled.map((result) => result.status)).toStrictEqual(['rejected', 'fulfilled']);
  expect(source?.moveState).toBeNull();
  expect(target).toBeUndefined();
});

test('it takes a receive with a token that manages the whole host', async () => {
  const ctx = await setupTest();
  const made = await ctx.targetApp.client.tokens.create({ name: 'mover', scope: 'manage' });

  const client = ctx.target.buildClient(made.secret);

  const ticket = await client.moves.receive({ name: 'dev', bytes: 1 });

  expect(ticket.peerUrl).toBe(TARGET_URL);
});

test('it refuses a receive with a token scoped to imps', async () => {
  const ctx = await setupTest();

  const made = await ctx.targetApp.client.tokens.create({
    name: 'mover',
    scope: 'manage',
    imps: ['dev'],
  });

  const client = ctx.target.buildClient(made.secret);

  expect(client.moves.receive({ name: 'dev', bytes: 1 })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it refuses a reissue with a token scoped to imps', async () => {
  const ctx = await setupTest();

  const made = await ctx.targetApp.client.tokens.create({
    name: 'mover',
    scope: 'manage',
    imps: ['dev'],
  });

  const client = ctx.target.buildClient(made.secret);

  expect(client.moves.reissue({ name: 'dev' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses an exec in a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.source.imps.openExec('dev', { argv: ['true'], tty: false })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it writes each /move step of the target to its audit log as the tailnet', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const calls = await ctx.targetApp.client.audit.calls({});

  const steps = calls.filter((call) => call.procedure.startsWith('move.'));

  expect(steps.map((call) => call.procedure)).toContain('move.commit');
  expect(steps).toIncludeAllPartialMembers([{ imp: 'dev', actor: 'tailnet' }]);
  expect(steps.filter((call) => call.imp !== 'dev' || call.actor !== 'tailnet')).toStrictEqual([]);
});

test('it goes on with a stream longer than 10 minutes while its parts keep coming', async () => {
  const ctx = await setupTest({
    partBytes: 4096,
    hook: (request, forward, hosts) => {
      if (request.headers.has(MOVE_PART_HEADER)) {
        hosts.target.advance(50_000);
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
});

test('it ends the stream when a part comes more than 60 s after the last', async () => {
  const ctx = await setupTest({
    partBytes: 4096,
    hook: (request, forward, hosts) => {
      if (request.headers.get(MOVE_PART_HEADER) === '1') {
        hosts.target.advance(61_000);
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove('dev');
  const staged = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the next part of the move stream came too late');
  expect(staged).toBeUndefined();
});

test('it refuses a stream that does not start with its header', async () => {
  const ctx = await setupTest({ hook: makeStubMoveStreamRewrite((frames) => frames.slice(1)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the stream does not start with its header');
  expect(staged).toBeUndefined();
});

test('it logs on the target a stream that fails, once and with its imp', async () => {
  const ctx = await setupTest({ hook: makeStubMoveStreamRewrite((frames) => frames.slice(1)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const lines = captureImpdLogs();

  await ctx.runMove('dev');

  expect(
    lines.filter((line) => line.includes('the stream does not start with its header')),
  ).toStrictEqual([
    'WARNING impd.move imp=dev the move stream failed: the stream does not start with its header',
    'WARNING impd.move imp=dev receive: the target answered 400 the stream does not start with its header',
  ]);
});

test("it takes a stream whose header names its ticket's imp", async () => {
  const ctx = await setupTest({ hook: makeStubMoveStreamRewrite((frames) => frames) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toBeNull();
});

test.each([
  ['a different name', 'other', 'not other'],
  ['a case variant', 'Dev', 'not Dev'],
  ['an empty name', '', 'not'],
  ['a name with whitespace', 'dev ', 'not dev'],
  ['a unicode look-alike', 'd\u0435v', 'not d\u0435v'],
])(
  "it refuses a stream whose header names %s for its ticket's imp",
  async (_kind, name, refusal) => {
    const ctx = await setupTest({
      hook: makeStubMoveStreamRewrite((frames) =>
        frames.map((frame) => {
          if (frame.type !== MOVE_FRAMES.header) {
            return frame;
          }

          const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

          return buildJsonMoveFrame(frame.type, { ...header, imp: { ...header.imp, name } });
        }),
      ),
    });

    await createUbuntuImage(ctx.source);
    await createUbuntuImage(ctx.target);

    await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
    await ctx.sourceApp.client.imps.stop({ name: 'dev' });

    const status = await ctx.runMove('dev');
    const staged = await listImps(ctx.target.db);

    expect(status.error).toBe(`receive: the target answered 403 the ticket is for dev, ${refusal}`);
    expect(staged).toStrictEqual([]);
  },
);

test('it refuses a stream for an imp id the target has', async () => {
  const taken = { id: '' };

  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, { ...header, imp: { ...header.imp, id: taken.id } });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const other = await ctx.targetApp.client.imps.create({ name: 'other', image: 'ubuntu' });

  taken.id = other.id;

  const status = await ctx.runMove('dev');

  expect(status.error).toContain(`this host has an imp with id ${other.id}`);
});

test('it refuses a stream that leaves out an image the target lacks', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, {
          ...header,
          image: { ...header.image, isIncluded: false },
        });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('this host has no image sha256:ubuntu');
});

test('it refuses a stream that ends after its header', async () => {
  const ctx = await setupTest({ hook: makeStubMoveStreamRewrite((frames) => frames.slice(0, 1)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the stream has no checkpoint file');
});

test('it refuses a stream that sends one file where another goes', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.file
          ? buildJsonMoveFrame(frame.type, {
              ...MoveFileSchema.parse(readJsonPayload(frame.payload)),
              kind: 'disk',
            })
          : frame,
      ),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the stream sent disk where checkpoint goes');
});

test('it refuses a stream that ends inside a file', async () => {
  const ctx = await setupTest({ hook: makeStubMoveStreamRewrite((frames) => frames.slice(0, 2)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the stream ended inside a file');
});

test('it refuses a file whose sha256 does not match its data', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.fileEnd
          ? buildJsonMoveFrame(frame.type, {
              ...FileEndSchema.parse(readJsonPayload(frame.payload)),
              sha256: '0'.repeat(64),
            })
          : frame,
      ),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('checkpoint: the sha256 does not match the data');
});

test('it refuses a frame inside a file that is neither data nor its end', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) => [
      ...frames.slice(0, 2),
      buildJsonMoveFrame(MOVE_FRAMES.end, {}),
    ]),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain(`an unexpected frame ${String(MOVE_FRAMES.end)} in a file`);
});

test('it refuses a data frame past the end of its file', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.file
          ? buildJsonMoveFrame(frame.type, {
              ...MoveFileSchema.parse(readJsonPayload(frame.payload)),
              sizeBytes: 0,
            })
          : frame,
      ),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('a DATA frame past the end of its file');
});

test('it refuses a stream that does not end with END', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.filter((frame) => frame.type !== MOVE_FRAMES.end),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the stream does not end with END');
  expect(staged).toBeUndefined();
});

test('it refuses ZFS streams that do not name each checkpoint once', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, { ...header, streams: [] });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the streams do not name each checkpoint once');
});

test('it refuses ZFS streams on a target that is not on ZFS', async () => {
  const ctx = await setupTest({
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, {
          ...header,
          streams: [
            { checkpoint: 0, dataset: 0, base: null },
            { checkpoint: null, dataset: 0, base: 0 },
          ],
        });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('this host is not on ZFS: it takes a move as files only');
});

test('it sends the disk and its checkpoints between two ZFS hosts as ZFS streams', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
  const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
  const left = await readImpByName(ctx.source.db, 'dev');

  const received = targetZfs
    .readPool()
    .commands.filter((command) => command.startsWith('zfs recv'));

  invariant(checkpoints[0]);

  expect(status.error).toBeNull();
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one']);
  expect(received).toHaveLength(2);

  expect(targetZfs.readPool().listSnapshots()).toContain(
    `tank/imp/disks/${moved.id}@${checkpoints[0].id}`,
  );

  expect(left).toBeUndefined();
});

test.each([
  ['source', false, 'sourceApp'],
  ['source', true, 'sourceApp'],
  ['target', false, 'targetApp'],
  ['target', true, 'targetApp'],
] as const)(
  'it finds nothing for a GC on the %s to drop or keep after a ZFS move (orphans: %p)',
  async (_host, orphans, app) => {
    const sourceZfs = buildStubZfsStorage('tank/imp');
    const targetZfs = buildStubZfsStorage('tank/imp');

    const ctx = await setupTest({
      source: { createStorage: sourceZfs.createStorage },
      target: { createStorage: targetZfs.createStorage },
    });

    await createZfsUbuntuImage(ctx.source);
    await createZfsUbuntuImage(ctx.target);

    await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
    await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });
    await ctx.runMove('dev', true);

    const sweep = await ctx[app].client.system.gc({ orphans });

    expect(sweep.dropped).toStrictEqual([]);
    expect(sweep.kept).toStrictEqual([]);
  },
);

test('it leaves no move snapshot and no staging dataset in either pool after a ZFS move', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);

  const snapshots = [sourceZfs, targetZfs].flatMap((zfs) => zfs.readPool().listSnapshots());
  const datasets = [sourceZfs, targetZfs].flatMap((zfs) => zfs.readPool().listDatasets());

  expect(status.error).toBeNull();
  expect(snapshots).not.toContainEqual(expect.stringContaining('@mv-'));
  expect(datasets).not.toContainEqual(expect.stringContaining('/staging/'));
});

test('it never commits a ZFS stream whose sum does not match', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.fileEnd
          ? buildJsonMoveFrame(frame.type, {
              ...FileEndSchema.parse(readJsonPayload(frame.payload)),
              sha256: '0'.repeat(64),
            })
          : frame,
      ),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);

  const pool = targetZfs.readPool();
  const received = pool.commands.filter((command) => command.startsWith('zfs recv'));

  const cleaned = pool.commands.filter(
    (command) => command.includes('/staging/mvin-') && !command.startsWith('zfs recv'),
  );

  const absent = await readImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('ZFS stream 0: the sha256 does not match');
  expect(received).toHaveLength(1);
  expect(pool.listDatasets()).not.toContainEqual(expect.stringContaining('/staging/'));
  expect(cleaned).toStrictEqual([]);
  expect(absent).toBeUndefined();
});

test('it moves an imp between ZFS hosts again after a stream whose sum did not match', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');
  const corrupt = { remaining: 1 };

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.fileEnd || corrupt.remaining === 0) {
          return frame;
        }

        corrupt.remaining -= 1;

        return buildJsonMoveFrame(frame.type, { sha256: '0'.repeat(64) });
      }),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const failed = await ctx.runMove('dev', true);

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const retried = await ctx.runMove('dev', true);

  expect(failed.error).toContain('ZFS stream 0: the sha256 does not match');
  expect(retried).toMatchObject({ isDone: true, error: null });
});

test('it refuses a ZFS move whose stream leaves out a ZFS stream', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.filter((frame) => frame.type !== MOVE_FRAMES.file),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('the stream has no ZFS stream 0');
});

test('it refuses a ZFS stream that ends before its sum', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.fileEnd ? buildJsonMoveFrame(MOVE_FRAMES.end, {}) : frame,
      ),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('ZFS stream 0 ended early');
});

test('it refuses a ZFS stream whose data frames come out of order', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: makeStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.data) {
          return frame;
        }

        const payload = new Uint8Array(frame.payload);

        new DataView(payload.buffer).setBigUint64(0, 1n);

        return { type: frame.type, payload };
      }),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('ZFS stream 0: a DATA frame out of order');
});

test('it fails a ZFS move to a target that left ZFS since the prepare', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: makeStubSwitchedStorageTarget('xfs'),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('the target is not on ZFS any more; prepare the move again');
});

test('it moves an imp from an XFS host to a ZFS host as files, its checkpoints as snapshots', async () => {
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({ target: { createStorage: targetZfs.createStorage } });

  await createUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'hello');

  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });

  invariant(checkpoints[0]);

  expect(status.error).toBeNull();

  expect(readFileSync(ctx.target.storage.resolveImpPaths(created.id).disk, 'utf8')).toStartWith(
    'hello',
  );

  expect(targetZfs.readPool().listSnapshots()).toContain(
    `tank/imp/disks/${created.id}@${checkpoints[0].id}`,
  );
});

test('it writes each move mark MOVE_TRANSITIONS holds, and no other, on both hosts', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit() });

  const marks = new Map<string, MoveState | null>();

  const written: (readonly [MoveState | null, MoveState | null])[] = [];

  const makeRecorder =
    (host: string) =>
    (write: ImpWrite): void => {
      if (write.kind === 'added' || write.kind === 'changed') {
        const key = `${host}/${write.imp.id}`;
        const from = marks.get(key) ?? null;

        if (from !== write.imp.moveState) {
          written.push([from, write.imp.moveState]);
        }

        marks.set(key, write.imp.moveState);
      }
    };

  const stopSource = ctx.source.db.writes.subscribe(makeRecorder('source'));
  const stopTarget = ctx.target.db.writes.subscribe(makeRecorder('target'));

  onTestFinished(() => {
    stopSource();
    stopTarget();
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  await ctx.sourceApp.client.imps.create({ name: 'web', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'web' });
  await ctx.runMove('web');

  expect(new Set(written.map(([from, to]) => `${String(from)} → ${String(to)}`))).toStrictEqual(
    new Set(MOVE_TRANSITIONS.map(([from, to]) => `${String(from)} → ${String(to)}`)),
  );
});
