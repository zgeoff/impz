import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { WarmHost, WarmMove } from '@impz/api';
import { deriveSlotAddress } from '../../host-net/net/addressing';
import { readTapMac } from '../../host-net/net/tap-devices';
import type { EgressService } from '../../network/egress/egress-service';
import type { ImpRecord } from '../../platform/db/imps';
import { listNetworkMembers } from '../../platform/db/networks';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import {
  readColdBootReason,
  readSnapshotMeta,
  writeSnapshotMeta,
} from '../../vm/sleep/snapshot-meta';
import type { SnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { readVmIdentity, writeVmIdentity } from '../../vm/sleep/vm-identity';
import type { HostIdentity } from '../../vm/sleep/vm-identity';
import { buildSystemDrivePath } from '../../vm/storage/data-layout';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { ImpOpsConfig } from '../imp-ops-config';
import type { MoveHeader } from './move-header';
import { MoveRequestError } from './move-request-error';
import { isSameHash } from './move-tickets';
import type { ReceiptBody } from './move-tickets';
import { buildWarmMove, collectWarmMismatches } from './warm-facts';

interface WarmSendDeps {
  readonly config: Pick<ImpOpsConfig, 'subnet'>;
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly egress: Pick<EgressService, 'readPolicy' | 'readAnswers'>;
  readonly readWarmHost: () => WarmHost;
  readonly readTapMac?: (tap: string) => string | null;
}

export async function checkWarmMove(
  deps: WarmSendDeps,
  imp: ImpRecord,
  meta: SnapshotMeta,
  target: WarmHost | null,
): Promise<WarmMove> {
  const egress = await deps.egress.readPolicy(imp.name);

  const move = buildWarmMove(imp.slot, egress.mode, meta, deps.readWarmHost());

  const mismatches =
    target === null
      ? ['the target does not say what it can load']
      : collectWarmMismatches(move, target);

  // The guest knows its gateway by this tap's MAC, so the target's tap for
  // the slot must carry the same one.
  const address = deriveSlotAddress(imp.slot, { subnet: deps.config.subnet, portBase: 0 });
  const tapMac = (deps.readTapMac ?? readTapMac)(address.tap);

  if (tapMac === null) {
    mismatches.push(`it has no tap ${address.tap} since a restart; wake it once first`);
  } else if (tapMac !== address.hostMac) {
    mismatches.push(`its tap ${address.tap} has a MAC from before slot MACs (${tapMac})`);
  }

  const members = await listNetworkMembers(deps.db);

  const networks = members
    .filter((member) => member.impId === imp.id)
    .map((member) => member.network);

  if (networks.length > 0) {
    mismatches.push(`it is on private networks (${networks.join(', ')}); impz net leave first`);
  }

  if (mismatches.length > 0) {
    throw new ImpdError('PRECONDITION_FAILED', {
      message: `${imp.name} cannot move with its memory: ${mismatches.join('; ')}. impz move --stop moves it cold`,
    });
  }

  return move;
}

export function requireSnapshotMeta(
  deps: Pick<WarmSendDeps, 'storage'>,
  imp: ImpRecord,
): SnapshotMeta {
  const meta = readSnapshotMeta(deps.storage.resolveImpPaths(imp.id));

  if (meta === null) {
    throw new Error(`${imp.name} has no memory snapshot to move`);
  }

  return meta;
}

export interface WarmParts {
  readonly meta: SnapshotMeta;
  readonly isDriveIncluded: boolean;
}

export async function readWarmHeader(
  deps: WarmSendDeps,
  imp: ImpRecord,
  warm: WarmParts,
): Promise<NonNullable<MoveHeader['warm']>> {
  const egress = await deps.egress.readPolicy(imp.name);

  return {
    move: buildWarmMove(imp.slot, egress.mode, warm.meta, deps.readWarmHost()),
    meta: warm.meta,
    vm: readVmIdentity(deps.storage.resolveImpPaths(imp.id)),
    isDriveIncluded: warm.isDriveIncluded,
    answers: EGRESS_MODE_TRAITS[egress.mode].hasAllowList ? deps.egress.readAnswers(imp.slot) : [],
  };
}

interface WarmReceiveDeps {
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly egress: Pick<EgressService, 'writeAnswers'>;
  readonly readIdentity: () => HostIdentity;
  readonly readWarmHost: () => WarmHost;
}

export function requireWarmMove(deps: Pick<WarmReceiveDeps, 'readWarmHost'>, move: WarmMove): void {
  const mismatches = collectWarmMismatches(move, deps.readWarmHost());

  if (mismatches.length > 0) {
    throw new MoveRequestError(409, `this host cannot load the memory: ${mismatches.join('; ')}`);
  }
}

// Firecracker reopens the drive by the path the snapshot names, so only this
// host's own path for that sha256 is accepted.
export function requireOwnDrivePath(
  deps: Pick<WarmReceiveDeps, 'dataDir'>,
  warm: NonNullable<MoveHeader['warm']>,
): void {
  const path = buildSystemDrivePath(deps.dataDir, warm.meta.systemDrive);
  const named = [warm.meta.systemDrivePath, warm.vm?.systemDrivePath];

  if (named.some((given) => given !== undefined && given !== path)) {
    throw new MoveRequestError(400, `the snapshot's drive is not at ${path}`);
  }
}

type ReceivedFile = ReceiptBody['files'][number];

interface WarmFiles {
  readonly impId: string;
  readonly warm: NonNullable<MoveHeader['warm']>;
  readonly readFile: (
    kind: 'system-drive' | 'vmstate' | 'mem',
    path: string,
  ) => Promise<{ sha256: string; bytes: number }>;
  readonly temp: string;
  readonly onFile: (file: ReceivedFile) => void;
}

export async function writeWarmFiles(deps: WarmReceiveDeps, files: WarmFiles): Promise<void> {
  const warm = files.warm;
  const paths = deps.storage.resolveImpPaths(files.impId);

  if (warm.isDriveIncluded) {
    const got = await files.readFile('system-drive', files.temp);

    await writeSystemDrive(deps, files.temp, warm.meta);

    files.onFile({ kind: 'system-drive', sha256: got.sha256, bytes: got.bytes });
  }

  mkdirSync(paths.snapshotDir, { recursive: true });

  for (const kind of ['vmstate', 'mem'] as const) {
    const path = kind === 'vmstate' ? paths.vmstate : paths.memFile;

    const got = await files.readFile(kind, path);

    files.onFile({ kind, sha256: got.sha256, bytes: got.bytes });
  }

  if (warm.vm !== null) {
    writeVmIdentity(paths, warm.vm);
  }

  for (const answer of warm.answers) {
    await deps.egress.writeAnswers(warm.move.slot, answer.names, [answer]);
  }

  const reason = readColdBootReason(warm.meta, deps.readIdentity());

  if (reason !== null) {
    throw new MoveRequestError(409, `the memory snapshot cannot load here: ${reason}`);
  }

  writeSnapshotMeta(paths, warm.meta);
}

// A drive lands under its own sha256, which other snapshots trust, so what
// arrived must hash to the name the snapshot gives it.
async function writeSystemDrive(
  deps: Pick<WarmReceiveDeps, 'dataDir'>,
  temp: string,
  meta: Readonly<SnapshotMeta>,
): Promise<void> {
  const path = buildSystemDrivePath(deps.dataDir, meta.systemDrive);

  const sha256 = await readFileSha256(temp);

  if (!isSameHash(sha256, meta.systemDrive)) {
    throw new MoveRequestError(400, 'the system drive does not match its sha256');
  }

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    renameSync(temp, path);
  }
}

async function readFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}
