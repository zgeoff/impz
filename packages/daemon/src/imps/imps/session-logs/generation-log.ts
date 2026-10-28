import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, open, stat, truncate, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import type { StartTimer } from '../../../platform/process/clock';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { buildKeyedMutex } from '../../../platform/process/keyed-mutex';
import { startRealTimer } from '../../../platform/process/start-real-timer';
import { writeFileDurablyAsync } from '../../../platform/process/write-file-durably';
import {
  AgentBootIdSchema,
  AgentGenerationSchema,
  AgentSessionNameSchema,
} from '../../../vm/agent-client/agent-ids';
import { getLogBounds } from './plan-log-read';
import type { LogBounds, LogSegment } from './plan-log-read';

const META_FILE = 'meta.json';
const SEGMENT_SUFFIX = '.seg';
const COMMIT_DELAY_MS = 1000;
const OffsetSchema = z.int().nonnegative();

const GenerationMetaSchema = z.object({
  version: z.literal(1),
  session: AgentSessionNameSchema,
  executionGeneration: AgentGenerationSchema,
  bootId: AgentBootIdSchema,
  startedAt: z.int(),

  origin: OffsetSchema,
  segments: z.array(z.object({ start: OffsetSchema, length: OffsetSchema })),
  state: z.enum(['live', 'ended']),

  endedAt: z.int().optional(),
  end: OffsetSchema.optional(),
  exitCode: z.int().nullable().optional(),

  stopped: z.enum(['disk_full', 'imp_limit']).optional(),
});

type StoredMeta = z.infer<typeof GenerationMetaSchema>;

export type GenerationMeta = Readonly<Omit<StoredMeta, 'segments'>> & {
  readonly segments: readonly LogSegment[];
};

export interface GenerationEnd {
  readonly end?: number;
  readonly exitCode?: number | null;
}

export interface GenerationLog {
  readonly readMeta: () => GenerationMeta;

  readonly setOrigin: (offset: number) => void;

  readonly append: (data: Uint8Array) => Promise<void>;

  readonly skipTo: (offset: number) => void;

  readonly removeOldestSegment: () => Promise<boolean>;
  readonly finish: (end: Readonly<GenerationEnd>) => Promise<void>;
  readonly stop: (reason: StopReason) => Promise<void>;

  readonly commit: () => Promise<void>;

  readonly abandon: () => void;
}

export interface GenerationLogOptions {
  readonly directory: string;

  readonly segmentBytes: number;
  readonly maxBytes: number;

  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;

  readonly startTimer?: StartTimer;
}

type StopReason = NonNullable<StoredMeta['stopped']>;

type MetaChange = Readonly<Partial<Omit<StoredMeta, 'segments'>>>;

export function getSegmentPath(directory: string, start: number): string {
  return join(directory, `${String(start)}${SEGMENT_SUFFIX}`);
}

export function readGenerationMeta(directory: string): GenerationMeta | null {
  const path = join(directory, META_FILE);

  if (!existsSync(path)) {
    return null;
  }

  try {
    return GenerationMetaSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function countLogBytes(meta: GenerationMeta): number {
  return meta.segments.reduce((sum, segment) => sum + segment.length, 0);
}

export function getGenerationBounds(meta: GenerationMeta): LogBounds {
  return getLogBounds(meta.segments, meta.origin);
}

export async function createGenerationLog(
  options: GenerationLogOptions,
  identity: Readonly<Pick<StoredMeta, 'session' | 'executionGeneration' | 'bootId'>>,
): Promise<GenerationLog> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });

  const log = startGenerationLog(options, {
    version: 1,
    ...identity,
    startedAt: options.now(),
    origin: 0,
    segments: [],
    state: 'live',
  });

  await log.commit();

  return log;
}

export async function loadGenerationLog(
  options: GenerationLogOptions,
  meta: GenerationMeta,
): Promise<GenerationLog> {
  const kept: LogSegment[] = [];

  for (const segment of meta.segments) {
    const path = getSegmentPath(options.directory, segment.start);

    const size = await readFileSize(path);

    if (size === null) {
      continue;
    }

    // A host crash can leave a segment file shorter than its count, so the
    // log keeps what is there.
    const length = Math.min(size, segment.length);

    if (size > length) {
      await truncate(path, length);
    }

    kept.push({ start: segment.start, length });
  }

  const named = new Set(kept.map((segment) => `${String(segment.start)}${SEGMENT_SUFFIX}`));

  for (const file of readdirSync(options.directory)) {
    if (file !== META_FILE && !named.has(file)) {
      rmSync(join(options.directory, file), { force: true });
    }
  }

  const log = startGenerationLog(options, { ...meta, segments: kept });

  await log.commit();

  return log;
}

async function readFileSize(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);

    return stats.size;
  } catch {
    return null;
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // gone already
  }
}

async function stopQuietly(file: FileHandle): Promise<void> {
  try {
    await file.close();
  } catch {
    // the log is being abandoned
  }
}

function startGenerationLog(options: GenerationLogOptions, initial: GenerationMeta): GenerationLog {
  const meta: StoredMeta = {
    ...initial,
    segments: initial.segments.map((segment) => ({ ...segment })),
  };

  const state = {
    file: null as FileHandle | null,

    current: null as StoredMeta['segments'][number] | null,
    skipTo: null as number | null,

    cancelTimer: null as (() => void) | null,

    settled: initial.state === 'ended' || initial.stopped !== undefined,
    abandoned: false,
  };

  const writes = buildKeyedMutex();

  const runInOrder = <T>(task: () => Promise<T>, fallback: T): Promise<T> =>
    writes.runExclusive(META_FILE, () => (state.abandoned ? Promise.resolve(fallback) : task()));

  const readEnd = (): number => getLogBounds(meta.segments, meta.origin).logEnd;

  const stopFile = async (): Promise<void> => {
    const file = state.file;

    state.file = null;
    state.current = null;

    if (file === null) {
      return;
    }

    try {
      await file.datasync();
    } finally {
      await file.close();
    }
  };

  // Segment bytes reach the disk before the meta that counts them, so a crash
  // leaves at most an uncounted tail, which no read sees.
  const writeMeta = async (): Promise<void> => {
    await state.file?.datasync();

    await writeFileDurablyAsync(join(options.directory, META_FILE), JSON.stringify(meta), {
      mode: 0o600,
    });
  };

  const runCommit = async (): Promise<void> => {
    try {
      await runInOrder(writeMeta, undefined);
    } catch (error) {
      getImpdLogger('session').warning('session log {directory}: {error}', {
        directory: options.directory,
        error: String(error),
      });
    }
  };

  const startTimer: StartTimer =
    options.startTimer ??
    ((fire, durationMs) => startRealTimer(fire, durationMs, { isUnref: true }));

  const startCommitTimer = (): void => {
    if (state.cancelTimer !== null) {
      return;
    }

    state.cancelTimer = startTimer(() => {
      state.cancelTimer = null;
      void runCommit();
    }, COMMIT_DELAY_MS);
  };

  const stopCommitTimer = (): void => {
    if (state.cancelTimer !== null) {
      state.cancelTimer();

      state.cancelTimer = null;
    }
  };

  const removeOldest = async (): Promise<boolean> => {
    const [oldest] = meta.segments;

    if (oldest === undefined || meta.segments.length < 2) {
      return false;
    }

    meta.segments.shift();

    await writeMeta();
    await removeQuietly(getSegmentPath(options.directory, oldest.start));

    return true;
  };

  const startSegment = async (start: number): Promise<void> => {
    await stopFile();

    await options.requireRoom(options.segmentBytes);

    const path = getSegmentPath(options.directory, start);

    await removeQuietly(path);

    const file = await open(path, 'wx', 0o600);

    if (state.abandoned) {
      await file.close();

      throw new Error('session log: abandoned');
    }

    state.file = file;
    state.current = { start, length: 0 };

    meta.segments.push(state.current);

    while (countLogBytes(meta) + options.segmentBytes > options.maxBytes) {
      if (!(await removeOldest())) {
        break;
      }
    }
  };

  const writeBytes = async (data: Uint8Array): Promise<void> => {
    if (state.settled) {
      return;
    }

    let rest = data;

    while (rest.byteLength > 0) {
      const current = state.current;
      const file = state.file;

      if (
        current === null ||
        file === null ||
        state.skipTo !== null ||
        current.length >= options.segmentBytes
      ) {
        await startSegment(state.skipTo ?? readEnd());

        state.skipTo = null;
        continue;
      }

      const piece = rest.subarray(0, options.segmentBytes - current.length);

      await file.write(piece, 0, piece.byteLength, current.length);

      current.length += piece.byteLength;
      rest = rest.subarray(piece.byteLength);
    }

    startCommitTimer();
  };

  const writeSettled = async (change: MetaChange): Promise<void> => {
    stopCommitTimer();

    state.settled = true;

    Object.assign(meta, change);

    try {
      await writeMeta();
    } finally {
      await stopFile();
    }
  };

  return {
    readMeta: () => ({ ...meta, segments: meta.segments.map((segment) => ({ ...segment })) }),
    setOrigin: (offset) => {
      if (meta.segments.length === 0) {
        meta.origin = offset;
      }
    },
    append: (data) => runInOrder(() => writeBytes(data), undefined),
    skipTo: (offset) => {
      if (meta.segments.length === 0) {
        meta.origin = offset;

        return;
      }

      state.skipTo = offset;
    },
    removeOldestSegment: () => runInOrder(removeOldest, false),
    finish: (end) =>
      runInOrder(async () => {
        if (meta.state === 'ended') {
          return;
        }

        await writeSettled({
          state: 'ended',
          endedAt: options.now(),
          ...(end.end !== undefined && { end: end.end }),
          ...(end.exitCode !== undefined && { exitCode: end.exitCode }),
        });
      }, undefined),
    stop: (reason) => runInOrder(() => writeSettled({ stopped: reason }), undefined),
    commit: () => runInOrder(writeMeta, undefined),
    abandon: () => {
      state.abandoned = true;

      stopCommitTimer();

      if (state.file !== null) {
        void stopQuietly(state.file);
        state.file = null;
      }
    },
  };
}
