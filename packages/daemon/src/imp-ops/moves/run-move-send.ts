import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { WarmHost } from '@impz/api';
import type { Config } from '../../config';
import type { Broker } from '../../network/broker/broker-service';
import type { EgressService } from '../../network/egress/egress-service';
import { listCheckpoints } from '../../platform/db/checkpoints';
import { listColdBoots } from '../../platform/db/cold-boots';
import { findImageById } from '../../platform/db/images';
import { updateImpMove } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { updateMoveSend } from '../../platform/db/move-sends';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StartTimer } from '../../platform/process/clock';
import { encodeSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import type { MoveMode, StorageBackend } from '../../vm/storage/storage-backend';
import { buildMovedLeases, requireLeasesKept } from './build-moved-leases';
import { buildWarmHeader, requireSnapshotMeta } from './check-warm-move';
import type { WarmParts } from './check-warm-move';
import { MOVE_FRAMES, encodeCommand, encodeFile, encodeJsonFrame } from './move-frames';
import {
  MOVE_FINISH_HEADER,
  MOVE_PART_HEADER,
  MOVE_PATHS,
  MoveOfferReplySchema,
} from './move-header';
import type { MoveHeader } from './move-header';
import { sendInParts } from './move-parts';
import { ReceiptSchema, parseTicket, readReceipt } from './move-tickets';
import type { ReadonlyReceiptBody, ReceiptBody } from './move-tickets';
import { OfferRefusalError } from './offer-refusal-error';
import { openMoveParts } from './open-move-parts';
import type { StreamPart } from './open-move-parts';
import { removeMoveParts } from './remove-move-parts';
import { requireOk } from './require-ok';
import { sendToPeer } from './send-to-peer';

interface MoveSendDeps {
  readonly config: Pick<Config, 'subnet'>;
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'openMoveSource' | 'resolveImpPaths'>;
  readonly grants: Pick<Broker, 'listGrantDetails'>;
  readonly egress: Pick<EgressService, 'readPolicy' | 'readAnswers'>;
  readonly readWarmHost: () => WarmHost;
  readonly readTapMac?: (tap: string) => string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly startPeerDeadline?: StartTimer;
  readonly partBytes?: number;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// where a send goes, with its ticket, how it carries the disk, and whether
// the memory goes too
export interface SendTarget {
  readonly peer: string;
  readonly ticket: string;
  readonly mode: MoveMode;
  readonly isWarm: boolean;
}

// what a running send reports as it goes
interface SendProgress {
  readonly signal: AbortSignal;
  readonly onData: (bytes: number) => void;
}

type SentFile = ReceiptBody['files'][number];

// The send up to a receipt that matches it: the offer, the stream in parts
// and the finish. From here both hosts hold the imp, until the commit.
export async function runMoveSend(
  deps: MoveSendDeps,
  imp: ImpRecord,
  target: SendTarget,
  progress: SendProgress,
): Promise<void> {
  const peer = target.peer;
  const ticket = target.ticket;
  const secret = parseTicket(ticket)?.secret ?? '';
  const signal = progress.signal;

  const image = await findImageById(deps.db, imp.imageId);

  const meta = target.isWarm ? requireSnapshotMeta(deps, imp) : null;

  const offer = await sendToPeer(deps, peer, MOVE_PATHS.offer, ticket, {
    body: JSON.stringify({
      imageDigest: image?.digest ?? '',
      ...(meta !== null && { systemDrive: meta.systemDrive }),
    }),
    signal,
    extraHeaders: { 'content-type': 'application/json' },
  });

  const offered = await requireOk(offer, 'offer');

  const reply = MoveOfferReplySchema.parse(offered);

  if (target.mode === 'zfs' && reply.storage !== 'zfs') {
    throw new Error('the target is not on ZFS any more; prepare the move again');
  }

  // a target from before elastic memory would land the imp at a fixed size
  if (imp.maxMemoryMib > imp.memoryMib && !reply.keepsMaxMemory) {
    throw new OfferRefusalError(
      "the target's impd predates elastic memory and would drop the imp's max memory; upgrade it first",
    );
  }

  await requireLeasesKept(deps, imp, reply.keepsLeases);

  // a target from before the setting would put the imp's disk in its backups
  if (!imp.isBackedUp && !reply.keepsBackupOff) {
    throw new OfferRefusalError(
      "the target's impd predates imps left out of backups and would back this one up; upgrade it first",
    );
  }

  // a move never changes the policy, either way
  const policy = await deps.egress.readPolicy(imp.name);

  if (EGRESS_MODE_TRAITS[policy.mode].isPublic && !reply.keepsPublicEgress) {
    throw new OfferRefusalError(
      "the target's impd predates the public egress policy and would receive the imp as none; upgrade it first",
    );
  }

  const warm = meta === null ? null : { meta, isDriveIncluded: reply.needsSystemDrive };

  const opened = await openMoveParts(deps, imp, target.mode, reply.needsImage, warm);

  const sent: SentFile[] = [];

  try {
    const header = await buildHeader(deps, imp, reply.needsImage, opened.streams, warm);

    const frames = encodeStream(header, opened.parts, progress.onData, (file) => {
      sent.push(file);
    });

    await sendInParts(
      frames,
      async (part, body) => {
        const sentPart = await sendToPeer(deps, peer, MOVE_PATHS.receive, ticket, {
          body,
          duplex: 'half',
          signal,
          extraHeaders: { [MOVE_PART_HEADER]: String(part) },
        });

        await requireOk(sentPart, `part ${String(part)}`);
      },
      deps.partBytes,
    );
  } finally {
    await removeMoveParts(deps, opened);
  }

  const response = await sendToPeer(deps, peer, MOVE_PATHS.receive, ticket, {
    signal,
    extraHeaders: { [MOVE_FINISH_HEADER]: '1' },
  });

  const answer = await requireOk(response, 'receive');

  const receipt = ReceiptSchema.parse(answer);
  const body = readReceipt(receipt, secret);

  if (body === null) {
    throw new Error('the receipt is not signed with this ticket');
  }

  checkReceiptFiles(body, imp, sent);

  // from here both hosts hold the imp, and neither may wake it: sending →
  // moved, as MOVE_TRANSITIONS holds
  await updateMoveSend(deps.db, imp.id, { receipt: JSON.stringify(receipt) });
  await updateImpMove(deps.db, imp.id, 'moved');
}

async function buildHeader(
  deps: MoveSendDeps,
  imp: ImpRecord,
  isImageIncluded: boolean,
  streams: MoveHeader['streams'],
  warm: WarmParts | null,
): Promise<MoveHeader> {
  const image = await findImageById(deps.db, imp.imageId);

  if (image === undefined) {
    throw new Error(`${imp.name} has no image row`);
  }

  const listed = await listCheckpoints(deps.db, imp.id);

  const checkpoints = listed.toReversed();

  const egress = await deps.egress.readPolicy(imp.name);
  const grants = await deps.grants.listGrantDetails(imp.name);
  const leases = await buildMovedLeases(deps, imp);

  return {
    version: 1,
    imp: {
      id: imp.id,
      name: imp.name,
      vcpus: imp.vcpus,
      memoryMib: imp.memoryMib,
      maxMemoryMib: imp.maxMemoryMib,
      httpPort: imp.httpPort,
      diskBytes: imp.diskBytes,
      cpu: imp.cpu,
      egress: { mode: egress.mode, allow: [...egress.allow] },
      grants: grants.filter((grant) => grant.filter === null).map((grant) => grant.secret),
      filteredGrants: grants.flatMap((grant) =>
        grant.filter === null ? [] : [{ secret: grant.secret, filter: grant.filter }],
      ),
      isIdentityResetPending: imp.isIdentityResetPending,
      isDiskGrowPending: imp.isDiskGrowPending,
      isBackedUp: imp.isBackedUp,
      coldBoots: await listColdBoots(deps.db, imp.id),
      leases,
    },
    image: {
      name: image.name,
      ref: image.ref,
      digest: image.digest,
      sizeBytes: image.sizeBytes,
      source: image.source,
      sourceImp: image.sourceImp,
      isIncluded: isImageIncluded,
    },
    checkpoints: checkpoints.map((checkpoint) => ({
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
      diskBytes: checkpoint.diskBytes,
    })),
    streams,
    warm: warm === null ? null : await buildWarmHeader(deps, imp, warm),
  };
}

// The stream: the header, each file's frames, END. `onFile` gets each
// file's sha256 as it ends, for the receipt to repeat.
async function* encodeStream(
  header: Readonly<MoveHeader>,
  parts: readonly StreamPart[],
  onData: (bytes: number) => void,
  onFile: (file: SentFile) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  yield encodeJsonFrame(MOVE_FRAMES.header, encodeHeader(header));

  for (const part of parts) {
    let bytes = 0;

    const count = (more: number) => {
      bytes += more;

      onData(more);
    };

    const onSum = (sha256: string) => {
      onFile({
        kind: part.file.kind,
        ...(part.file.index !== undefined && { index: part.file.index }),
        sha256,
        bytes,
      });
    };

    yield* part.kind === 'file'
      ? encodeFile(part.path, part.file, count, onSum)
      : encodeCommand(part.open, part.file, count, onSum);
  }

  yield encodeJsonFrame(MOVE_FRAMES.end, {});
}

// The header as JSON: a warm move's snapshot record goes as meta.json holds
// it, its sessions and services in the agent's own JSON form
function encodeHeader(header: Readonly<MoveHeader>): unknown {
  if (header.warm === null) {
    return header;
  }

  return { ...header, warm: { ...header.warm, meta: encodeSnapshotMeta(header.warm.meta) } };
}

// the receipt must name this imp and repeat every sha256 the stream sent
function checkReceiptFiles(
  body: ReadonlyReceiptBody,
  imp: Readonly<ImpRecord>,
  sent: readonly Readonly<SentFile>[],
): void {
  const same =
    body.impId === imp.id &&
    body.name === imp.name &&
    body.files.length === sent.length &&
    body.files.every(
      (file, index) =>
        file.kind === sent[index]?.kind &&
        file.index === sent[index].index &&
        file.sha256 === sent[index].sha256 &&
        file.bytes === sent[index].bytes,
    );

  if (!same) {
    throw new Error('the receipt does not match what was sent');
  }
}
