import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { EgressPolicy, WarmHost } from '@impz/api';
import { EgressPolicySchema } from '@impz/api';
import { writeChangedBlocks } from '../backup/write-changed-blocks';
import type { Broker } from '../broker/broker-service';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';
import { createCheckpoint } from '../db/checkpoints';
import { writeMovedBoots } from '../db/cold-boots';
import { createImage, findImageByDigest, findImageByName } from '../db/images';
import { findImpById } from '../db/imps';
import { updateMoveTicket } from '../db/move-tickets';
import type { MoveTicketRow } from '../db/move-tickets';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import type { Imps } from '../imps/imp-service';
import { readErrorMessage } from '../read-error-message';
import type { HostIdentity } from '../sleep/vm-identity';
import { toDigestHex } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import { writeReceivedLeases } from './build-moved-leases';
import { requireOwnDrivePath, requireWarmMove, writeWarmFiles } from './check-warm-move';
import { COMMIT_WINDOW_MS } from './commit-window-ms';
import { createByteCounter } from './create-byte-counter';
import type { ByteCounter } from './create-byte-counter';
import {
  FileEndSchema,
  MOVE_FRAMES,
  MoveFileSchema,
  createDataHash,
  createFrameReader,
  readDataPayload,
  readJsonPayload,
} from './move-frames';
import type { FrameReader, MoveFile } from './move-frames';
import { MoveHeaderSchema } from './move-header';
import type { MoveHeader } from './move-header';
import { MoveRequestError } from './move-request-error';
import { buildReceipt, isSameHash } from './move-tickets';
import type { ReceiptBody } from './move-tickets';
import { removeStagedImp } from './remove-staged-imp';
import { requireTicketedName } from './require-ticketed-name';
import { writeMoveStreams } from './write-move-streams';

const ID_ATTEMPTS = 5;

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
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp'>;
  readonly grants: Pick<Broker, 'addGrant' | 'listSecrets'>;
  readonly egress: Pick<EgressService, 'writeAnswers'>;
  readonly readIdentity: () => HostIdentity;
  readonly readWarmHost: () => WarmHost;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// a response's status and JSON body, which more than one request may send
export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

type ReceivedFile = ReceiptBody['files'][number];

// The stream after its ticket: the header, the image, the disk and the
// memory, then the receipt; a failure removes the staged imp
export async function readMoveStream(
  deps: ReceiveStreamDeps,
  tempDir: string,
  stream: ReadableStream<Uint8Array>,
  row: MoveTicketRow,
  secret: string,
): Promise<Reply> {
  const reader = createFrameReader(stream);

  const first = await reader.readFrame();

  if (first?.type !== MOVE_FRAMES.header) {
    throw new MoveRequestError(400, 'the stream does not start with its header');
  }

  const header = MoveHeaderSchema.parse(readJsonPayload(first.payload));

  // each lease ends this long after now: the time it had left when the
  // source built the header, however long the disk then takes
  const headerAt = deps.now();

  requireTicketedName(row.name, header.imp.name);

  if ((await findImpById(deps.db, header.imp.id)) !== undefined) {
    throw new MoveRequestError(409, `this host has an imp with id ${header.imp.id}`);
  }

  // the ticket's checks again, on what the stream itself says
  if (header.warm !== null) {
    requireWarmMove(deps, header.warm.move);
    requireOwnDrivePath(deps, header.warm);

    if (header.warm.move.slot !== row.slot) {
      throw new MoveRequestError(409, `the ticket keeps slot ${String(row.slot)}, not this one`);
    }
  } else if (row.slot !== null) {
    throw new MoveRequestError(409, 'the ticket is for a warm move, and the stream is cold');
  }

  await updateMoveTicket(deps.db, row.id, { imp_id: header.imp.id });

  const count = createByteCounter(row.bytes);
  const files: ReceivedFile[] = [];

  mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  const temp = join(tempDir, `${row.id}.part`);

  const writeDisk = async (impId: string): Promise<void> => {
    if (header.streams !== null) {
      await writeMoveStreams(deps, impId, header, reader, count, (file) => {
        files.push(file);
      });

      return;
    }

    await deps.storage.createImpDisk(impId, { kind: 'empty' });

    const disk = deps.storage.resolveImpPaths(impId).disk;

    for (const [index, checkpoint] of header.checkpoints.entries()) {
      const got = await readFileInto(reader, 'checkpoint', temp, count);

      await writeChangedBlocks(temp, disk);

      const made = await createCheckpointDisk(deps, impId);

      await createCheckpoint(deps.db, {
        id: made.id,
        impId,
        label: checkpoint.label,
        sizeBytes: made.sizeBytes,
        createdAt: checkpoint.createdAt,
        diskBytes: checkpoint.diskBytes,
      });

      files.push({ kind: 'checkpoint', index, sha256: got.sha256, bytes: got.bytes });
    }

    const got = await readFileInto(reader, 'disk', temp, count);

    await writeChangedBlocks(temp, disk);

    files.push({ kind: 'disk', sha256: got.sha256, bytes: got.bytes });
  };

  try {
    // files take twice the data: each sits in the temp file, then on the
    // disk; streams go straight into `zfs recv`, and only the image's files
    // pass through a temp file
    const imageBytes = header.image.isIncluded ? header.image.sizeBytes : 0;
    const room = header.streams === null ? 2 * row.bytes : row.bytes + imageBytes;

    await deps.diskBudget.withRoom(room, async () => {
      const image = await requireImage(deps, reader, header, count, temp);

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
        policy: resolvePolicy(header, deps.log),
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

      // the staged imp's own rows: they go with it if the stream fails
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
      throw new MoveRequestError(400, 'the stream does not end with END');
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
    secret,
  );

  await updateMoveTicket(deps.db, row.id, {
    receipt: JSON.stringify(receipt),
    commit_until: deps.now() + COMMIT_WINDOW_MS,
  });

  const form = header.streams === null ? 'files' : 'zfs streams';

  deps.log(`impd: move: ${header.imp.name}: received as ${form}, waiting for the commit`);

  return { status: 200, body: receipt };
}

// Each file into a sparse temp file, then over the disk block by block, so
// the checkpoints share every block they did on the source
async function readFileInto(
  reader: FrameReader,
  expected: MoveFile['kind'],
  path: string,
  count: ByteCounter,
): Promise<{ sha256: string; bytes: number; file: MoveFile }> {
  const start = await reader.readFrame();

  if (start?.type !== MOVE_FRAMES.file) {
    throw new MoveRequestError(400, `the stream has no ${expected} file`);
  }

  const file = MoveFileSchema.parse(readJsonPayload(start.payload));

  if (file.kind !== expected) {
    throw new MoveRequestError(400, `the stream sent ${file.kind} where ${expected} goes`);
  }

  const handle = await open(path, 'w');

  const hash = createDataHash();
  let bytes = 0;

  try {
    await handle.truncate(file.sizeBytes);

    for (;;) {
      const frame = await reader.readFrame();

      if (frame === null) {
        throw new MoveRequestError(400, 'the stream ended inside a file');
      }

      if (frame.type === MOVE_FRAMES.fileEnd) {
        const sha256 = FileEndSchema.parse(readJsonPayload(frame.payload)).sha256;

        if (!isSameHash(sha256, hash.digest('hex'))) {
          throw new MoveRequestError(400, `${expected}: the sha256 does not match the data`);
        }

        return { sha256, bytes, file };
      }

      if (frame.type !== MOVE_FRAMES.data) {
        throw new MoveRequestError(400, `an unexpected frame ${String(frame.type)} in a file`);
      }

      const data = readDataInFile(frame.payload, file.sizeBytes);

      await handle.write(data.data, 0, data.data.length, data.offset);

      hash.update(frame.payload);

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
    throw new MoveRequestError(400, 'a DATA frame past the end of its file');
  }

  return data;
}

async function createCheckpointDisk(deps: ReceiveStreamDeps, impId: string) {
  for (let attempt = 1; ; attempt += 1) {
    const id = buildCheckpointId();

    try {
      return { id, sizeBytes: await deps.storage.createCheckpoint(impId, id) };
    } catch (error) {
      if (!(error instanceof CheckpointIdTakenError) || attempt >= ID_ATTEMPTS) {
        throw error;
      }
    }
  }
}

// The image by the source's digest when this host has it, else from the
// stream under the digest of what arrived (docs/guides/hosts.md#moves)
async function requireImage(
  deps: ReceiveStreamDeps,
  reader: FrameReader,
  header: MoveHeader,
  count: ByteCounter,
  tempBase: string,
): Promise<{ readonly name: string; readonly files: readonly ReceivedFile[] }> {
  const existing = await findImageByDigest(deps.db, header.image.digest);

  if (existing !== undefined) {
    return { name: existing.name, files: [] };
  }

  if (!header.image.isIncluded) {
    throw new MoveRequestError(409, `this host has no image ${header.image.digest}`);
  }

  const temps = { rootfs: `${tempBase}.rootfs`, config: `${tempBase}.config` };

  try {
    const rootfs = await readFileInto(reader, 'image-rootfs', temps.rootfs, count);
    const config = await readFileInto(reader, 'image-config', temps.config, count);

    const files: ReceivedFile[] = [
      { kind: 'image-rootfs', sha256: rootfs.sha256, bytes: rootfs.bytes },
      { kind: 'image-config', sha256: config.sha256, bytes: config.bytes },
    ];

    const digest = buildReceivedDigest(rootfs.sha256, config.sha256);

    const known = await findImageByDigest(deps.db, digest);

    if (known !== undefined) {
      return { name: known.name, files };
    }

    await deps.storageGate.join(() =>
      deps.storage.createImage(digest, async (dir) => {
        await copyFile(temps.config, join(dir, 'config.json'));

        writeFileSync(join(dir, 'rootfs.ext4'), '');

        await writeChangedBlocks(temps.rootfs, join(dir, 'rootfs.ext4'));
      }),
    );

    const taken = await findImageByName(deps.db, header.image.name);

    const hex = toDigestHex(digest).slice(0, 8);

    const name =
      taken === undefined ? header.image.name : `${header.image.name.slice(0, 22)}-${hex}`;

    await createImage(deps.db, {
      name,
      ref: header.image.ref,
      digest,
      sizeBytes: header.image.sizeBytes,
      source: header.image.source,
      sourceImp: header.image.sourceImp,
    });

    return { name, files };
  } finally {
    rmSync(temps.rootfs, { force: true });
    rmSync(temps.config, { force: true });
  }
}

// the sha256 of a whole file, as content-addressed paths name it
// a received image's digest: its two files' stream sums, as they arrived
function buildReceivedDigest(rootfsSha256: string, configSha256: string): string {
  const hash = createHash('sha256').update(`rootfs ${rootfsSha256}\nconfig ${configSha256}\n`);

  return `sha256:${hash.digest('hex')}`;
}

// a policy this impd cannot read comes as none, never more open
function resolvePolicy(header: MoveHeader, log: (message: string) => void): EgressPolicy {
  const parsed = EgressPolicySchema.safeParse(header.imp.egress);

  if (parsed.success) {
    return parsed.data;
  }

  log(`impd: move: ${header.imp.name}: unknown egress policy; received as none`);

  return { mode: 'none', allow: [] };
}

// Only a grant of a secret this host has by that name; the rest are
// logged, never made
async function createGrants(deps: ReceiveStreamDeps, header: MoveHeader): Promise<void> {
  const secrets = await deps.grants.listSecrets();

  const known = new Set(secrets.map((secret) => secret.name));

  const grants = [
    ...header.imp.grants.map((secret) => ({ secret, filter: undefined })),
    ...header.imp.filteredGrants,
  ];

  for (const grant of grants) {
    const secretName = grant.secret;

    if (!known.has(secretName)) {
      deps.log(`impd: move: ${header.imp.name}: grant ${secretName} dropped: no such secret here`);
      continue;
    }

    try {
      await deps.grants.addGrant(header.imp.name, secretName, null, grant.filter);
    } catch (error) {
      deps.log(
        `impd: move: ${header.imp.name}: grant ${secretName} not kept: ${readErrorMessage(error)}`,
      );
    }
  }
}
