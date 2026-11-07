import { getErrorMessage } from '@impz/shared';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import * as z from 'zod';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { buildExitError } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import { createSemaphore } from '../../platform/process/semaphore';

// the page handler reads the memory file in blocks of the guest's 2 MiB pages
const BLOCK_MIB = 2;

// the bench that measured the warm ran it in the sleep's two slots, so its
// restore and wake figures hold for two warms at once
const WARM_CONCURRENCY = 2;

export type WarmEnd = 'woke' | 'stopped' | 'destroyed' | 'impdStopped';

export interface WarmTarget {
  readonly impId: string;
  readonly name: string;
  readonly memFile: string;
}

export interface MemoryWarm {
  // reads the memory file's data blocks into the page cache in the background,
  // when they hold no more data than the cap
  readonly start: (target: Readonly<WarmTarget>) => void;

  // ends the imp's warm, if one runs, and resolves once its handler is gone
  readonly stop: (impId: string, end: WarmEnd) => Promise<void>;

  // ends every warm that runs
  readonly stopAll: () => Promise<void>;
}

export interface MemoryWarmDeps {
  readonly handlerBin: string;
  readonly capMib: number;
  readonly run: CommandRunner;
}

type WarmOutcome =
  | { readonly kind: 'warmed'; readonly blocks: number; readonly warmMs: number }
  | { readonly kind: 'overCap'; readonly blocks: number }
  | { readonly kind: 'ended'; readonly end: WarmEnd; readonly warmMs: number }
  | { readonly kind: 'failed'; readonly error: string };

// queued: waits for a slot, with no handler started, so a stop ends it at once;
// running: its handler reads the file, and a stop waits for the handler to exit
type WarmPhase = 'queued' | 'running';

interface RunningWarm {
  readonly target: Readonly<WarmTarget>;
  readonly controller: AbortController;
  readonly state: { phase: WarmPhase; end: WarmEnd | null };
  readonly startedMs: number;
  readonly done: Promise<void>;
}

const WarmReportSchema = z.object({ blocks: z.int().nonnegative() });

export function createMemoryWarm(deps: Readonly<MemoryWarmDeps>): MemoryWarm {
  const running = new Map<string, RunningWarm>();

  const slots = createSemaphore(WARM_CONCURRENCY);

  const readBlocks = async (
    mode: '--count-data' | '--warm',
    memFile: string,
    signal: AbortSignal,
  ): Promise<number> => {
    signal.throwIfAborted();

    const argv = [deps.handlerBin, mode, memFile];

    const result = await deps.run(argv, { signal });

    if (result.exitCode !== 0) {
      throw buildExitError(argv, result);
    }

    return WarmReportSchema.parse(JSON.parse(result.stdout)).blocks;
  };

  const runWarm = async (memFile: string, signal: AbortSignal): Promise<WarmOutcome> => {
    const startedMs = performance.now();

    try {
      const blocks = await readBlocks('--count-data', memFile, signal);

      if (blocks * BLOCK_MIB > deps.capMib) {
        return { kind: 'overCap', blocks };
      }

      const read = await readBlocks('--warm', memFile, signal);

      return { kind: 'warmed', blocks: read, warmMs: Math.round(performance.now() - startedMs) };
    } catch (error) {
      return { kind: 'failed', error: getErrorMessage(error) };
    }
  };

  const stop = async (impId: string, end: WarmEnd): Promise<void> => {
    const warm = running.get(impId);

    if (warm === undefined) {
      return;
    }

    warm.state.end = end;

    warm.controller.abort();

    if (warm.state.phase === 'running') {
      await warm.done;

      return;
    }

    running.delete(impId);

    const warmMs = Math.round(performance.now() - warm.startedMs);

    logWarm(warm.target, { kind: 'ended', end, warmMs }, deps.capMib);
  };

  return {
    start: (target) => {
      invariant(!running.has(target.impId), `imp ${target.impId} slept with its warm running`);

      const controller = new AbortController();

      const state: RunningWarm['state'] = { phase: 'queued', end: null };
      const startedMs = performance.now();

      // a warm stopped while queued is gone from the map and logged, so its
      // slot runs nothing
      const runInSlot = (): Promise<WarmOutcome | null> => {
        if (controller.signal.aborted) {
          return Promise.resolve(null);
        }

        state.phase = 'running';

        return runWarm(target.memFile, controller.signal);
      };

      const runAndLog = async (): Promise<void> => {
        const outcome = await slots.run(runInSlot);

        if (outcome === null) {
          return;
        }

        running.delete(target.impId);

        const end = state.end;
        const warmMs = Math.round(performance.now() - startedMs);
        const isEnded = outcome.kind === 'failed' && end !== null;
        const logged: WarmOutcome = isEnded ? { kind: 'ended', end, warmMs } : outcome;

        logWarm(target, logged, deps.capMib);
      };

      running.set(target.impId, { target, controller, state, startedMs, done: runAndLog() });
    },
    stop,
    stopAll: async () => {
      await Promise.all([...running.keys()].map((impId) => stop(impId, 'impdStopped')));
    },
  };
}

function logWarm(target: Readonly<WarmTarget>, outcome: WarmOutcome, capMib: number): void {
  const logger = getImpdLogger('imps').with({ imp: target.name });

  match(outcome)
    .with({ kind: 'warmed' }, (warmed) => {
      logger.info('warmed the memory file in {warmMs}ms: {blocks} blocks of 2 MiB', {
        warmMs: String(warmed.warmMs),
        blocks: String(warmed.blocks),
      });
    })
    .with({ kind: 'overCap' }, (over) => {
      logger.info(
        'left the memory file cold: its {dataMib} MiB of data pass the warm cap of {capMib} MiB',
        { dataMib: String(over.blocks * BLOCK_MIB), capMib: String(capMib) },
      );
    })
    .with({ kind: 'ended' }, (ended) => {
      logger.info("stopped the memory file's warm after {warmMs}ms: {reason}", {
        warmMs: String(ended.warmMs),
        reason: formatWarmEnd(ended.end),
      });
    })
    .with({ kind: 'failed' }, (failed) => {
      logger.warning("the memory file's warm failed: {error}", { error: failed.error });
    })
    .exhaustive();
}

function formatWarmEnd(end: WarmEnd): string {
  return match(end)
    .with('woke', () => 'the imp woke')
    .with('stopped', () => 'the imp stopped')
    .with('destroyed', () => 'the imp is destroyed')
    .with('impdStopped', () => 'impd stopped')
    .exhaustive();
}
