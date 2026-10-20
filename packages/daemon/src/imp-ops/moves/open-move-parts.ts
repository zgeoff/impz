import { listCheckpoints } from '../../platform/db/checkpoints';
import { findImageById } from '../../platform/db/images';
import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StreamedCommand } from '../../platform/process/run-stream';
import { buildImagePaths } from '../../vm/storage/data-layout';
import type { MoveMode, StorageBackend } from '../../vm/storage/storage-backend';
import type { WarmParts } from './check-warm-move';
import type { MoveFile } from './move-frames';
import type { MoveHeader } from './move-header';

interface MovePartsDeps {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'openMoveSource' | 'resolveImpPaths'>;
}

// One piece of the stream after the header: a file, or a command's output
export type StreamPart =
  | { readonly kind: 'file'; readonly path: string; readonly file: MoveFile }
  | { readonly kind: 'command'; readonly open: () => StreamedCommand; readonly file: MoveFile };

export interface OpenedParts {
  readonly parts: readonly StreamPart[];
  readonly streams: MoveHeader['streams'];

  // what `zfs send` says its streams take; null for files
  readonly estimateBytes: number | null;
  readonly close: () => Promise<void>;
}

// What a send carries after the header, in order: the image (when asked),
// then each checkpoint oldest first and the disk, as files or as streams
export async function openMoveParts(
  deps: MovePartsDeps,
  imp: ImpRecord,
  mode: MoveMode,
  isImageIncluded: boolean,
  warm: WarmParts | null,
): Promise<OpenedParts> {
  const opened = await openDiskParts(deps, imp, mode, isImageIncluded);

  if (warm === null) {
    return opened;
  }

  // after the disk: the drive the snapshot reopens, then its two files
  const paths = deps.storage.resolveImpPaths(imp.id);

  const memory: StreamPart[] = [
    ...(warm.isDriveIncluded && warm.meta.systemDrivePath !== undefined
      ? [
          {
            kind: 'file' as const,
            path: warm.meta.systemDrivePath,
            file: { kind: 'system-drive' as const, sizeBytes: 0 },
          },
        ]
      : []),
    { kind: 'file', path: paths.vmstate, file: { kind: 'vmstate', sizeBytes: 0 } },
    { kind: 'file', path: paths.memFile, file: { kind: 'mem', sizeBytes: 0 } },
  ];

  return { ...opened, parts: [...opened.parts, ...memory] };
}

async function openDiskParts(
  deps: MovePartsDeps,
  imp: ImpRecord,
  mode: MoveMode,
  isImageIncluded: boolean,
): Promise<OpenedParts> {
  const image = await findImageById(deps.db, imp.imageId);

  if (image === undefined) {
    throw new Error(`${imp.name} has no image row`);
  }

  const listed = await listCheckpoints(deps.db, imp.id);

  const checkpoints = listed.toReversed();
  const imagePaths = buildImagePaths(deps.dataDir, image.digest);

  const parts: StreamPart[] = isImageIncluded
    ? [
        { kind: 'file', path: imagePaths.rootfs, file: { kind: 'image-rootfs', sizeBytes: 0 } },
        { kind: 'file', path: imagePaths.config, file: { kind: 'image-config', sizeBytes: 0 } },
      ]
    : [];

  const ids = checkpoints.map((checkpoint) => checkpoint.id);

  const source = await deps.storage.openMoveSource(imp.id, ids, mode);

  if (source.kind === 'files') {
    for (const [index, path] of source.checkpointPaths.entries()) {
      parts.push({ kind: 'file', path, file: { kind: 'checkpoint', index, sizeBytes: 0 } });
    }

    parts.push({ kind: 'file', path: source.diskPath, file: { kind: 'disk', sizeBytes: 0 } });

    return { parts, streams: null, estimateBytes: null, close: source.close };
  }

  const streams = source.steps.map((step) => ({
    checkpoint: step.checkpointId === null ? null : ids.indexOf(step.checkpointId),
    dataset: step.dataset,
    base: step.base,
  }));

  for (const [index, step] of source.steps.entries()) {
    parts.push({
      kind: 'command',
      open: step.open,
      file: { kind: 'zfs-stream', index, sizeBytes: 0 },
    });
  }

  const estimateBytes = source.steps.reduce((sum, step) => sum + step.estimateBytes, 0);

  return { parts, streams, estimateBytes, close: source.close };
}
