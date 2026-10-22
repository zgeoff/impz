import type { StreamedCommand } from '../../platform/process/run-stream';
import type { ImpPaths } from './data-layout';

export type StorageBackendKind = 'xfs' | 'zfs';

export type DiskSource =
  | { readonly kind: 'image'; readonly digest: string }
  | { readonly kind: 'imp'; readonly impId: string }
  | { readonly kind: 'checkpoint'; readonly impId: string; readonly checkpointId: string }
  | { readonly kind: 'empty' };

interface BackupCopyOptions {
  readonly isReusable: boolean;
}

interface BackupTreeRequest {
  readonly runId: string;
  readonly imps: readonly { readonly impId: string; readonly checkpointIds: readonly string[] }[];
  readonly imageDigests: readonly string[];
}

export interface BackupTree {
  readonly impIds: ReadonlySet<string>;
  readonly checkpointIds: ReadonlySet<string>;
  readonly imageDigests: ReadonlySet<string>;
  readonly close: () => Promise<void>;
}

interface StorageUsage {
  readonly usedBytes: number;
  readonly availableBytes: number;
}

export interface ImpDiskUsage {
  readonly exclusiveBytes: number;
  readonly sharedBytes: number;
  readonly isUpperBound: boolean;
}

/* @internal */
export interface DiskUsageReport {
  readonly imps: ReadonlyMap<string, ImpDiskUsage>;
  readonly isPartial: boolean;
}

// A removal frees an image's own blocks only, and a clone or a reflink of them keeps them.
export interface ImageSpace {
  readonly freedBytes: number;
  readonly isShared: boolean;
}

interface ImageSpaceReport {
  readonly images: ReadonlyMap<string, ImageSpace>;
  readonly freeingBytes: number;
}

export interface LiveStorage {
  readonly impIds: ReadonlySet<string>;
  readonly checkpointIds: ReadonlySet<string>;
  readonly imageDigests: ReadonlySet<string>;
}

export interface DroppedStorage {
  readonly kind: 'imp' | 'checkpoint' | 'image' | 'snapshot' | 'memory';
  readonly id: string;
}

export interface OrphanStorage {
  readonly kind: 'imp' | 'image' | 'memory' | 'checkpoint';
  readonly id: string;
  readonly location: string;
  readonly bytes: number;
  readonly createdAt: Date | null;
  readonly snapshots: readonly string[];
}

interface SweepOptions {
  readonly isDryRun: boolean;
  readonly isOrphans: boolean;
}

export interface SweepResult {
  readonly dropped: readonly DroppedStorage[];
  readonly kept: readonly OrphanStorage[];
}

export type MoveMode = 'files' | 'zfs';

export interface SendStep {
  readonly checkpointId: string | null;
  readonly dataset: number;
  readonly base: number | null;
  readonly estimateBytes: number;
  readonly open: () => StreamedCommand;
}

export type MoveSource =
  | {
      readonly kind: 'files';
      readonly checkpointPaths: readonly string[];
      readonly diskPath: string;
      readonly close: () => Promise<void>;
    }
  | {
      readonly kind: 'zfs';
      readonly steps: readonly SendStep[];
      readonly close: () => Promise<void>;
    };

export interface ReceiveStep {
  readonly isCheckpoint: boolean;
  readonly dataset: number;
  readonly base: number | null;
}

export interface ReceivedCheckpoint {
  readonly id: string;
  readonly sizeBytes: number;
}

export interface StorageBackend {
  readonly kind: StorageBackendKind;
  readonly start: (live: LiveStorage) => Promise<void>;
  readonly dropUnnamed: (live: LiveStorage, options: SweepOptions) => Promise<SweepResult>;
  readonly resolveImpPaths: (impId: string) => ImpPaths;
  readonly openMoveSource: (
    impId: string,
    checkpointIds: readonly string[],
    mode: MoveMode,
  ) => Promise<MoveSource>;
  readonly receiveMoveSnapshots: (
    impId: string,
    steps: readonly ReceiveStep[],
    readStep: (index: number) => ReadableStream<Uint8Array>,
    buildId: () => string,
  ) => Promise<ReceivedCheckpoint[]>;
  readonly createImage: (
    digest: string,
    write: (directory: string) => Promise<void>,
  ) => Promise<void>;
  readonly createImageFromImp: (
    digest: string,
    impId: string,
    steps: Readonly<{
      hold: (clone: () => Promise<void>) => Promise<void>;
      write: (directory: string) => Promise<void>;
    }>,
  ) => Promise<void>;
  readonly removeImage: (digest: string) => Promise<void>;

  readonly createImpDisk: (impId: string, source: DiskSource) => Promise<void>;
  readonly removeImpDisk: (impId: string, checkpointIds: readonly string[]) => Promise<void>;
  readonly createCheckpoint: (impId: string, checkpointId: string) => Promise<number>;
  readonly removeCheckpoint: (impId: string, checkpointId: string) => Promise<void>;
  readonly restoreCheckpoint: <T>(
    impId: string,
    checkpointId: string,
    halt: () => Promise<T>,
  ) => Promise<T>;

  // The caller holds the imp's lock and freezes a running guest only around this call, so the
  // copy is crash-consistent.
  readonly createBackupCopy: (
    impId: string,
    runId: string,
    options: BackupCopyOptions,
  ) => Promise<void>;
  readonly openBackupTree: (request: BackupTreeRequest) => Promise<BackupTree>;

  readonly readUsage: () => Promise<StorageUsage>;
  readonly readWarnings: () => readonly string[];
  readonly measureUsage: (
    imps: readonly { readonly impId: string; readonly checkpointIds: readonly string[] }[],
  ) => Promise<DiskUsageReport>;
  readonly measureImages: (digests: readonly string[]) => Promise<ImageSpaceReport>;
  readonly stop: () => Promise<void>;
}

// ZFS keeps a deleted checkpoint's snapshot while a fork's clone depends on it, so its id stays
// taken and the caller picks another.
export class CheckpointIdTakenError extends Error {
  override name = 'CheckpointIdTakenError';

  constructor(checkpointId: string) {
    super(`a snapshot named ${checkpointId} exists already`);
  }
}
