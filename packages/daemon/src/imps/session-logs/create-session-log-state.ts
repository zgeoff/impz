import { createActor } from 'xstate';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { buildLogKey } from './build-log-key';
import type { GenerationEnd, GenerationLog, GenerationLogOptions } from './generation-log';
import { getGenerationDir } from './session-log-files';
import { sessionLogMachine } from './session-log-machine';
import type { LiveLog } from './session-log-machine';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

export interface SessionLogStateDeps {
  readonly limits: SessionLogLimits;
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly startTimer?: GenerationLogOptions['startTimer'];
}

export type SessionLogState = ReturnType<typeof createSessionLogState>;

const SEGMENTS_PER_LOG = 2;
const LIMIT_CHECKS_PER_SEGMENT = 16;

export function createSessionLogState(deps: SessionLogStateDeps) {
  const segmentBytes = Math.max(1, Math.floor(deps.limits.generationMaxBytes / SEGMENTS_PER_LOG));
  const limitCheckBytes = Math.max(1, Math.floor(segmentBytes / LIMIT_CHECKS_PER_SEGMENT));
  const actor = createActor(sessionLogMachine);

  actor.on('cap.notice', (notice) => {
    deps.log(
      `impd: imp ${notice.impId}: logs no more sessions: it has ${String(deps.limits.impMaxLive)} live logs`,
    );
  });

  actor.start();

  const send = actor.send.bind(actor);
  const getContext = () => actor.getSnapshot().context;
  const findLive = (key: string) => getContext().live.get(key);
  const findTap = (key: string) => getContext().taps.get(key);
  const isTapped = (key: string) => getContext().taps.has(key);
  const isDropped = (key: string) => getContext().dropped.has(key);
  const isRecovered = (impId: string) => getContext().recovered.has(impId);
  const isCurrent = (entry: LiveLog): boolean => findLive(entry.key) === entry;
  const isDestroyed = (impId: string) => getContext().forgotten.has(impId);
  const getLife = (impId: string) => getContext().lives.get(impId) ?? 0;

  const isForgotten = (impId: string, life: number) =>
    isDestroyed(impId) || getLife(impId) !== life;

  const countCreating = (impId: string) =>
    [...getContext().creating].filter((key) => key.startsWith(`${impId}/`)).length;

  const readUncheckedBytes = (impId: string) => getContext().uncheckedBytes.get(impId) ?? 0;

  const buildOptions = (imp: SessionLogImp, generation: string): GenerationLogOptions => ({
    directory: getGenerationDir(imp.sessionLogsDir, generation),
    segmentBytes,
    maxBytes: deps.limits.generationMaxBytes,
    requireRoom: deps.requireRoom,
    now: deps.now,
    log: deps.log,
    ...(deps.startTimer !== undefined && { startTimer: deps.startTimer }),
  });

  const readLive = (impId: string) => (generation: string) =>
    findLive(buildLogKey(impId, generation))?.log.readMeta() ?? null;

  const listLive = (impId: string) =>
    [...getContext().live.values()].filter((entry) => entry.impId === impId);

  const printError = (imp: SessionLogImp, error: unknown): void => {
    deps.log(`impd: session logs of imp ${imp.id}: ${getErrorMessage(error)}`);
  };

  const setLive = (
    imp: SessionLogImp,
    generation: string,
    session: string,
    log: GenerationLog,
    isStopped = false,
  ) => {
    const entry: LiveLog = {
      key: buildLogKey(imp.id, generation),
      impId: imp.id,
      session,
      generation,
      log,
    };

    send({ type: 'log.add', entry, isStopped });

    return entry;
  };

  const writeEnd = async (entry: LiveLog, end: GenerationEnd): Promise<void> => {
    send({ type: 'log.end', entry });

    await entry.log.finish(end);
  };

  return {
    send,
    findLive,
    findTap,
    isTapped,
    isDropped,
    isRecovered,
    isCurrent,
    isDestroyed,
    readLife: getLife,
    isForgotten,
    countCreating,
    readUncheckedBytes,
    buildOptions,
    readLive,
    listLive,
    printError,
    setLive,
    writeEnd,
    limitCheckBytes,
  };
}
