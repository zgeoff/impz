import { mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { WarmHost } from '@impz/api';
import invariant from 'tiny-invariant';
import type { ImageService } from '../../imps/images/image-service';
import type { Imps } from '../../imps/imps/imp-service';
import type { EgressService } from '../../network/egress/egress-service';
import { writeMovedBoots } from '../../platform/db/cold-boots';
import { readImpById } from '../../platform/db/imps';
import { updateMoveTicket } from '../../platform/db/move-tickets';
import type { MoveTicketRow } from '../../platform/db/move-tickets';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { HostIdentity } from '../../vm/sleep/vm-identity';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { writeChangedBlocks } from '../../vm/storage/write-changed-blocks';
import type { ImpGrants } from '../imp-grants';
import { createImageFromFile } from '../imp-import/create-image-from-file';
import type { ImageImportDeps } from '../imp-import/create-image-from-file';
import { readImageInUse } from '../imp-import/read-image-in-use';
import { replayCheckpoints } from '../imp-import/replay-checkpoints';
import { resolveImportedPolicy } from '../imp-import/resolve-imported-policy';
import { restoreGrants } from '../imp-import/restore-grants';
import { buildOfferedDigests } from './build-offered-digests';
import { buildReceivedDigest } from './build-received-digest';
import { requireOwnDrivePath, requireWarmMove, writeWarmFiles } from './check-warm-move';
import { COMMIT_WINDOW_MS } from './commit-window-ms';
import { createByteCounter } from './create-byte-counter';
import type { ByteCounter } from './create-byte-counter';
import {
  FileEndSchema,
  MOVE_FRAMES,
  MoveFileSchema,
  createDataHash,
  createFileContentHash,
  createFrameReader,
  readDataPayload,
  readJsonPayload,
} from './move-frames';
import type { FrameReader, MoveFile } from './move-frames';
import { MoveHeaderSchema } from './move-header';
import type { MoveHeader } from './move-header';
import { MoveRequestError } from './move-request-error';
import { buildReceipt, isSameHash } from './move-tickets';
import type { Receipt, ReceiptBody } from './move-tickets';
import { writeReceivedLeases } from './read-moved-leases';
import { removeStagedImp } from './remove-staged-imp';
import { requireTicketedName } from './require-ticketed-name';
import { writeMoveStreams } from './write-move-streams';

interface ReceiveStreamDeps {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<
    StorageBackend,
    | 'kind'
    | 'resolveImpPaths'
    | 'createImpDisk'
    | 'createCheckpoint'
    | 'createImage'
    | 'receiveMoveSnapshots'
  >;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly images: Pick<ImageService, 'withImagePublisher'>;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp'>;
  readonly grants: Pick<ImpGrants, 'addGrant'>;
  readonly egress: Pick<EgressService, 'writeAnswers'>;
  readonly readIdentity: () => HostIdentity;
  readonly readWarmHost: () => WarmHost;
  readonly now: () => number;
  readonly writeImageFiles: ImageImportDeps['writeImageFiles'];
}

type ReceivedFile = ReceiptBody['files'][number];

interface ReadMoveStreamOptions {
  readonly tempDir: string;
  readonly stream: ReadableStream<Uint8Array>;
  readonly row: MoveTicketRow;
  readonly secret: string;
}

export async function readMoveStream(
  deps: ReceiveStreamDeps,
  options: ReadMoveStreamOptions,
): Promise<Receipt> {
  const row = options.row;
  const reader = createFrameReader(options.stream);

  const first = await reader.readFrame();

  if (first?.type !== MOVE_FRAMES.header) {
    throw new MoveRequestError('BAD_REQUEST', 'the stream does not start with its header');
  }

  const header = MoveHeaderSchema.parse(readJsonPayload(first.payload));
  const headerAt = deps.now();

  requireTicketedName(row.name, header.imp.name);

  if ((await readImpById(deps.db, header.imp.id)) !== undefined) {
    throw new MoveRequestError('CONFLICT', `this host has an imp with id ${header.imp.id}`);
  }

  if (header.warm !== null) {
    requireWarmMove(deps, header.warm.move);
    requireOwnDrivePath(deps, header.warm);

    if (header.warm.move.slot !== row.slot) {
      throw new MoveRequestError(
        'CONFLICT',
        `the ticket keeps slot ${String(row.slot)}, not this one`,
      );
    }
  } else if (row.slot !== null) {
    throw new MoveRequestError('CONFLICT', 'the ticket is for a warm move, and the stream is cold');
  }

  await updateMoveTicket(deps.db, row.id, { imp_id: header.imp.id });

  const count = createByteCounter(row.bytes);
  const files: ReceivedFile[] = [];

  mkdirSync(options.tempDir, { recursive: true, mode: 0o700 });

  const temp = join(options.tempDir, `${row.id}.part`);

  const writeDisk = async (impId: string): Promise<void> => {
    if (header.streams !== null) {
      await writeMoveStreams(deps, {
        impId,
        header,
        reader,
        count,
        onFile: (file) => {
          files.push(file);
        },
      });

      return;
    }

    const disk = await replayCheckpoints(deps, {
      impId,
      checkpoints: header.checkpoints,
      writeCheckpoint: async (_checkpoint, index, target) => {
        const got = await readFileInto(reader, 'checkpoint', temp, count);

        await writeChangedBlocks(temp, target);

        files.push({ kind: 'checkpoint', index, sha256: got.sha256, bytes: got.bytes });
      },
    });

    const got = await readFileInto(reader, 'disk', temp, count);

    await writeChangedBlocks(temp, disk);

    files.push({ kind: 'disk', sha256: got.sha256, bytes: got.bytes });
  };

  try {
    const imageBytes = header.image.isIncluded ? header.image.sizeBytes : 0;
    const room = header.streams === null ? 2 * row.bytes : row.bytes + imageBytes;

    await deps.diskBudget.withRoom(room, async () => {
      const image = await requireImage(deps, { reader, header, count, tempBase: temp });

      files.push(...image.files);

      await deps.imps.createImp({
        id: header.imp.id,
        name: header.imp.name,
        image: image.name,
        vcpus: header.imp.vcpus,
        memoryMib: header.imp.memoryMib,
        maxMemoryMib: header.imp.maxMemoryMib,
        httpPort: header.imp.httpPort,
        diskMib: Math.ceil(header.imp.diskBytes / (1024 * 1024)),
        policy: resolveImportedPolicy({
          mode: header.imp.egress.mode,
          allow: header.imp.egress.allow,
          onUnknown: (mode) => {
            getImpdLogger('move')
              .with({ imp: header.imp.name })
              .warning('unknown egress policy {egressPolicy}; imported as none', {
                egressPolicy: JSON.stringify(mode),
              });
          },
        }),
        cpuLimit: header.imp.cpu.limit,
        cpuWeight: header.imp.cpu.weight,
        start: false,
        moveState: 'receiving',
        isIdentityResetPending: header.imp.isIdentityResetPending,
        isDiskGrowPending: header.imp.isDiskGrowPending,
        isBackedUp: header.imp.isBackedUp,
        ...(header.warm !== null && { slot: header.warm.move.slot }),
        prepareDisk: writeDisk,
      });

      await writeMovedBoots(deps.db, header.imp.id, header.imp.coldBoots, deps.now());
      await writeReceivedLeases(deps, header, headerAt);

      if (header.warm !== null) {
        await writeWarmFiles(deps, {
          impId: header.imp.id,
          warm: header.warm,
          readFile: (kind, path) => readFileInto(reader, kind, path, count),
          temp,
          onFile: (file) => {
            files.push(file);
          },
        });
      }
    });

    const end = await reader.readFrame();

    if (end?.type !== MOVE_FRAMES.end) {
      throw new MoveRequestError('BAD_REQUEST', 'the stream does not end with END');
    }
  } catch (error) {
    await removeStagedImp(deps, header.imp.name, header.imp.id);

    throw error;
  } finally {
    rmSync(temp, { force: true });
  }

  await createGrants(deps, header);

  const receipt = buildReceipt(
    { ticketId: row.id, name: header.imp.name, impId: header.imp.id, files },
    options.secret,
  );

  await updateMoveTicket(deps.db, row.id, {
    receipt: JSON.stringify(receipt),
    commit_until: deps.now() + COMMIT_WINDOW_MS,
  });

  const form = header.streams === null ? 'files' : 'zfs streams';

  getImpdLogger('move')
    .with({ imp: header.imp.name })
    .info('received as {form}, waiting for the commit', { form });

  return receipt;
}

interface ReadFile {
  readonly sha256: string;
  readonly contentSha256: string | null;
  readonly bytes: number;
  readonly file: MoveFile;
}

async function readFileInto(
  reader: FrameReader,
  expected: MoveFile['kind'],
  path: string,
  count: ByteCounter,
): Promise<ReadFile> {
  const start = await reader.readFrame();

  if (start?.type !== MOVE_FRAMES.file) {
    throw new MoveRequestError('BAD_REQUEST', `the stream has no ${expected} file`);
  }

  const file = MoveFileSchema.parse(readJsonPayload(start.payload));

  if (file.kind !== expected) {
    throw new MoveRequestError(
      'BAD_REQUEST',
      `the stream sent ${file.kind} where ${expected} goes`,
    );
  }

  const handle = await open(path, 'w');

  const hash = createDataHash();
  const content = createFileContentHash(file);
  let bytes = 0;
  let end = 0;

  try {
    await handle.truncate(file.sizeBytes);

    for (;;) {
      const frame = await reader.readFrame();

      if (frame === null) {
        throw new MoveRequestError('BAD_REQUEST', 'the stream ended inside a file');
      }

      if (frame.type === MOVE_FRAMES.fileEnd) {
        const sha256 = FileEndSchema.parse(readJsonPayload(frame.payload)).sha256;

        if (!isSameHash(sha256, hash.digest('hex'))) {
          throw new MoveRequestError(
            'BAD_REQUEST',
            `${expected}: the sha256 does not match the data`,
          );
        }

        return { sha256, contentSha256: content?.digest() ?? null, bytes, file };
      }

      if (frame.type !== MOVE_FRAMES.data) {
        throw new MoveRequestError(
          'BAD_REQUEST',
          `an unexpected frame ${String(frame.type)} in a file`,
        );
      }

      const data = readDataInFile(frame.payload, file.sizeBytes);

      if (data.offset < end) {
        throw new MoveRequestError('BAD_REQUEST', `${expected}: a DATA frame out of order`);
      }

      end = data.offset + data.data.length;

      await handle.write(data.data, 0, data.data.length, data.offset);

      hash.update(frame.payload);
      content?.update(data.offset, data.data);
      bytes += data.data.length;

      count.add(data.data.length);
    }
  } finally {
    await handle.close();
  }
}

function readDataInFile(payload: Uint8Array, size: number): ReturnType<typeof readDataPayload> {
  const data = readDataPayload(payload);

  if (data.offset + data.data.length > size) {
    throw new MoveRequestError('BAD_REQUEST', 'a DATA frame past the end of its file');
  }

  return data;
}

interface RequireImageOptions {
  readonly reader: FrameReader;
  readonly header: MoveHeader;
  readonly count: ByteCounter;
  readonly tempBase: string;
}

async function requireImage(
  deps: ReceiveStreamDeps,
  options: RequireImageOptions,
): Promise<{ readonly name: string; readonly files: readonly ReceivedFile[] }> {
  const header = options.header;

  if (!header.image.isIncluded) {
    const offered = buildOfferedDigests(header.image.digest, header.image.receivedDigest);

    const existing = await readImageInUse(deps.db, offered, deps.now());

    if (existing === undefined) {
      throw new MoveRequestError('CONFLICT', `this host has no image ${header.image.digest}`);
    }

    return { name: existing.name, files: [] };
  }

  const temps = { rootfs: `${options.tempBase}.rootfs`, config: `${options.tempBase}.config` };

  try {
    const rootfs = await readFileInto(options.reader, 'image-rootfs', temps.rootfs, options.count);
    const config = await readFileInto(options.reader, 'image-config', temps.config, options.count);

    const files: ReceivedFile[] = [
      { kind: 'image-rootfs', sha256: rootfs.sha256, bytes: rootfs.bytes },
      { kind: 'image-config', sha256: config.sha256, bytes: config.bytes },
    ];

    invariant(rootfs.contentSha256 !== null && config.contentSha256 !== null);

    const digest = buildReceivedDigest(rootfs.contentSha256, config.contentSha256);

    const known = await readImageInUse(deps.db, [digest], deps.now());

    if (known !== undefined) {
      return { name: known.name, files };
    }

    const name = await deps.storageGate.join(() =>
      createImageFromFile(deps, {
        name: header.image.name,
        ref: header.image.ref,
        digest,
        sizeBytes: header.image.sizeBytes,
        source: header.image.source,
        sourceImp: header.image.sourceImp,
        rootfsPath: temps.rootfs,
        configPath: temps.config,
      }),
    );

    return { name, files };
  } finally {
    rmSync(temps.rootfs, { force: true });
    rmSync(temps.config, { force: true });
  }
}

async function createGrants(deps: ReceiveStreamDeps, header: MoveHeader): Promise<void> {
  const skipped = await restoreGrants(deps, header.imp.name, header.imp);

  for (const grant of skipped) {
    getImpdLogger('move')
      .with({ imp: header.imp.name })
      .warning('grant {secretName} not kept: {reason}', {
        secretName: grant.secret,
        reason: grant.reason,
      });
  }
}
