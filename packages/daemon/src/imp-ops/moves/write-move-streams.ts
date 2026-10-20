import { createCheckpoint } from '../../platform/db/checkpoints';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';
import type { ByteCounter } from './create-byte-counter';
import {
  FileEndSchema,
  MOVE_FRAMES,
  MoveFileSchema,
  createDataHash,
  readDataPayload,
  readJsonPayload,
} from './move-frames';
import type { FrameReader } from './move-frames';
import type { MoveHeader } from './move-header';
import { MoveRequestError } from './move-request-error';
import { isSameHash } from './move-tickets';
import type { ReceiptBody } from './move-tickets';

interface MoveStreamsDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'kind' | 'receiveMoveSnapshots'>;
}

type ReceivedFile = ReceiptBody['files'][number];

// ZFS to ZFS: each stream into `zfs recv`, then the checkpoints' rows
export async function writeMoveStreams(
  deps: MoveStreamsDeps,
  impId: string,
  header: MoveHeader,
  reader: FrameReader,
  count: ByteCounter,
  onFile: (file: ReceivedFile) => void,
): Promise<void> {
  const streams = checkStreams(header);

  if (deps.storage.kind !== 'zfs') {
    throw new MoveRequestError(409, 'this host is not on ZFS: it takes a move as files only');
  }

  const steps = streams.map((stream) => ({
    isCheckpoint: stream.checkpoint !== null,
    dataset: stream.dataset,
    base: stream.base,
  }));

  const received = await deps.storage.receiveMoveSnapshots(
    impId,
    steps,
    (index) =>
      readStreamFile(reader, index, count, (got) => {
        onFile({ kind: 'zfs-stream', index, sha256: got.sha256, bytes: got.bytes });
      }),
    buildCheckpointId,
  );

  const ordered = streams.filter((stream) => stream.checkpoint !== null);

  for (const [index, made] of received.entries()) {
    const checkpoint = header.checkpoints[ordered[index]?.checkpoint ?? -1];

    if (checkpoint === undefined) {
      throw new MoveRequestError(400, 'a stream names no checkpoint of the header');
    }

    await createCheckpoint(deps.db, {
      id: made.id,
      impId,
      label: checkpoint.label,
      sizeBytes: made.sizeBytes,
      createdAt: checkpoint.createdAt,
      diskBytes: checkpoint.diskBytes,
    });
  }
}

// the header's streams name each checkpoint once; the storage checks their
// order, the disk's last
function checkStreams(header: MoveHeader): NonNullable<MoveHeader['streams']> {
  const streams = header.streams ?? [];

  const named = streams.flatMap((stream) =>
    stream.checkpoint === null ? [] : [stream.checkpoint],
  );

  const isEach =
    named.length === header.checkpoints.length &&
    new Set(named).size === named.length &&
    named.every((checkpoint) => checkpoint < header.checkpoints.length);

  if (!isEach) {
    throw new MoveRequestError(400, 'the streams do not name each checkpoint once');
  }

  return streams;
}

interface StreamFile {
  readonly sha256: string;
  readonly bytes: number;
}

// One stream of the move as bytes: FILE, DATA at running offsets, FILE_END.
// `zfs recv` commits at the stream's end record, not at EOF, so the last
// DATA frame waits until FILE_END's sum matches.
function readStreamFile(
  reader: FrameReader,
  index: number,
  count: ByteCounter,
  onEnd: (file: StreamFile) => void,
): ReadableStream<Uint8Array> {
  const hash = createDataHash();

  const state: { isStarted: boolean; offset: number; held: Uint8Array | null } = {
    isStarted: false,
    offset: 0,
    held: null,
  };

  const requireStart = async () => {
    const start = await reader.readFrame();

    const file =
      start?.type === MOVE_FRAMES.file
        ? MoveFileSchema.parse(readJsonPayload(start.payload))
        : null;

    if (file?.kind !== 'zfs-stream' || file.index !== index) {
      throw new MoveRequestError(400, `the stream has no ZFS stream ${String(index)}`);
    }

    state.isStarted = true;
  };

  // the next DATA frame's bytes, or null once FILE_END's sum holds
  const readNext = async (): Promise<Uint8Array | null> => {
    const frame = await reader.readFrame();

    if (frame?.type === MOVE_FRAMES.fileEnd) {
      const sha256 = FileEndSchema.parse(readJsonPayload(frame.payload)).sha256;

      if (!isSameHash(sha256, hash.digest('hex'))) {
        throw new MoveRequestError(400, `ZFS stream ${String(index)}: the sha256 does not match`);
      }

      onEnd({ sha256, bytes: state.offset });

      return null;
    }

    if (frame?.type !== MOVE_FRAMES.data) {
      throw new MoveRequestError(400, `ZFS stream ${String(index)} ended early`);
    }

    const data = readDataPayload(frame.payload);

    if (data.offset !== state.offset) {
      throw new MoveRequestError(400, `ZFS stream ${String(index)}: a DATA frame out of order`);
    }

    hash.update(frame.payload);

    state.offset += data.data.length;

    count.add(data.data.length);

    return data.data;
  };

  return new ReadableStream<Uint8Array>({
    // a pull that enqueues nothing is not called again, so the first one
    // reads on until it has a frame to pass
    pull: async (controller) => {
      if (!state.isStarted) {
        await requireStart();
      }

      for (;;) {
        const next = await readNext();

        const held = state.held;

        state.held = next;

        if (held !== null) {
          controller.enqueue(held);
        }

        if (next === null) {
          controller.close();

          return;
        }

        if (held !== null) {
          return;
        }
      }
    },
  });
}
