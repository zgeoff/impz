import type { ExecStream } from '../agent-client/exec-stream';
import { readErrorMessage } from '../read-error-message';
import { findLogKey } from './find-log-key';
import type { GenerationEnd, GenerationLog, GenerationLogOptions } from './generation-log';
import { findGenerationDir } from './session-log-files';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

// what the state of the session logs reads of impd
export interface SessionLogStateDeps {
  readonly limits: SessionLogLimits;
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly startTimer?: GenerationLogOptions['startTimer'];
}

// one generation impd logs now
export interface LiveLog {
  readonly key: string;
  readonly impId: string;
  readonly session: string;
  readonly generation: string;
  readonly log: GenerationLog;
}

// a tap on its way: each opening has its own, so work that outlived its
// imp's life never frees a slot a later life took
export interface OpeningTap {
  readonly opening: true;
}

export type SessionLogState = ReturnType<typeof createSessionLogState>;

const SEGMENTS_PER_LOG = 2;

// an imp's limit is checked at least this often within a segment, so its logs
// pass it by at most this share of one
const LIMIT_CHECKS_PER_SEGMENT = 16;

// the live logs, their taps and the imps' lives that createSessionLogs's
// parts share
export function createSessionLogState(deps: SessionLogStateDeps) {
  const segmentBytes = Math.max(1, Math.floor(deps.limits.generationMaxBytes / SEGMENTS_PER_LOG));
  const limitCheckBytes = Math.max(1, Math.floor(segmentBytes / LIMIT_CHECKS_PER_SEGMENT));

  // the bytes each imp's logs took since its limit was last checked
  const uncheckedBytes = new Map<string, number>();
  const live = new Map<string, LiveLog>();

  // each live log's tap, or its opening's marker while one is on its way
  const taps = new Map<string, Readonly<ExecStream> | OpeningTap>();

  // removes the slot only while its owner still holds it
  const removeSlot = (key: string, owner: Readonly<ExecStream> | OpeningTap): void => {
    if (taps.get(key) === owner) {
      taps.delete(key);
    }
  };

  // whether the entry is still its key's live log: a log from an earlier
  // life of the imp, or ended, owns neither the key's slot nor its place
  const isCurrent = (entry: LiveLog): boolean => live.get(entry.key) === entry;

  // never tapped again in this impd's life: deleted while live, or stopped
  const dropped = new Set<string>();

  // imps whose directory this impd has read since it started
  const recovered = new Set<string>();

  // generations whose log is being made, so the cap counts them
  const creating = new Set<string>();

  // destroyed imps not back yet: nothing is tapped or written for them
  const forgotten = new Set<string>();

  // how often each imp was destroyed: work that began before a destroy
  // writes nothing, even once the imp is back under its id (a move home)
  const lives = new Map<string, number>();

  const readLife = (impId: string) => lives.get(impId) ?? 0;

  const isForgotten = (impId: string, life: number) =>
    forgotten.has(impId) || readLife(impId) !== life;

  // when each imp last logged a refusal for its cap
  const capNotices = new Map<string, number>();

  const buildOptions = (imp: SessionLogImp, generation: string): GenerationLogOptions => ({
    dir: findGenerationDir(imp.sessionLogsDir, generation),
    segmentBytes,
    maxBytes: deps.limits.generationMaxBytes,
    requireRoom: deps.requireRoom,
    now: deps.now,
    log: deps.log,
    ...(deps.startTimer !== undefined && { startTimer: deps.startTimer }),
  });

  const readLive = (impId: string) => (generation: string) =>
    live.get(findLogKey(impId, generation))?.log.readMeta() ?? null;

  const listLive = (impId: string) => [...live.values()].filter((entry) => entry.impId === impId);
  const isTapped = (key: string) => taps.has(key);

  const stopTap = (key: string): void => {
    const tap = taps.get(key);

    taps.delete(key);

    if (tap !== undefined && !isOpening(tap)) {
      tap.close();
    }
  };

  const printError = (imp: SessionLogImp, error: unknown): void => {
    deps.log(`impd: session logs of imp ${imp.id}: ${readErrorMessage(error)}`);
  };

  const setLive = (imp: SessionLogImp, generation: string, session: string, log: GenerationLog) => {
    const entry: LiveLog = {
      key: findLogKey(imp.id, generation),
      impId: imp.id,
      session,
      generation,
      log,
    };

    live.set(entry.key, entry);

    return entry;
  };

  const writeEnd = async (entry: LiveLog, end: GenerationEnd): Promise<void> => {
    if (isCurrent(entry)) {
      live.delete(entry.key);

      stopTap(entry.key);
    }

    await entry.log.finish(end);
  };

  return {
    uncheckedBytes,
    live,
    taps,
    removeSlot,
    isCurrent,
    dropped,
    recovered,
    creating,
    forgotten,
    lives,
    readLife,
    isForgotten,
    capNotices,
    buildOptions,
    readLive,
    listLive,
    isTapped,
    stopTap,
    printError,
    setLive,
    writeEnd,
    limitCheckBytes,
  };
}

function isOpening(slot: Readonly<ExecStream> | OpeningTap): slot is OpeningTap {
  return 'opening' in slot;
}
