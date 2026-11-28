import { existsSync } from 'node:fs';
import { getErrorMessage } from '@impz/shared';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import * as z from 'zod';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { runChecked } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import { createSemaphore } from '../../platform/process/semaphore';

// the page handler reads the memory file in blocks of the guest's 2 MiB pages
const BLOCK_MIB = 2;

// the bench that measured the warm ran it in the sleep's two slots, so its
// restore and wake figures hold for two warms at once
const WARM_CONCURRENCY = 2;

type WarmEnd = 'woke' | 'stopped' | 'destroyed' | 'impdStopped';

interface WarmTarget {
  readonly impID: string;
  readonly name: string;
  readonly memFile: string;

  // the file of the blocks that the imp's last wake served, numbered by first
  // fault, which may not exist
  readonly blockList: string;
}

export interface MemoryWarm {
  // reads the blocks that the imp's last wake served into the page cache in the
  // background, first fault first, until the next block would pass the cap;
  // with no record, reads the whole file's data blocks if they fit the cap
  readonly start: (target: Readonly<WarmTarget>) => void;

  // ends the imp's warm, if one runs, and resolves once its handler is gone
  readonly stop: (impID: string, end: WarmEnd) => Promise<void>;

  // ends every warm that runs, and starts none after
  readonly stopAll: () => Promise<void>;
}

export interface MemoryWarmDeps {
  readonly handlerBin: string;
  readonly capMib: number;
  readonly run: CommandRunner;
}

// recorded: the data blocks among those that the last wake served, in the order
// of their first fault;
// whole: every data block of the file, when no record exists
type WarmScope = 'recorded' | 'whole';

type WarmOutcome =
  | {
      readonly kind: 'warmed';
      readonly scope: WarmScope;
      readonly blocks: number;

      // the blocks the scope holds, of which a recorded warm reads the first
      readonly scopeBlocks: number;
      readonly warmMs: number;
    }
  | { readonly kind: 'overCap'; readonly scope: WarmScope; readonly blocks: number }
  | { readonly kind: 'ended'; readonly end: WarmEnd; readonly warmMs: number }
  | { readonly kind: 'closed' }
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

type HandlerMode = '--count-data' | '--warm' | '--count-blocks' | '--warm-blocks';

const WHOLE_MODES = { count: '--count-data', warm: '--warm' } as const;
const RECORDED_MODES = { count: '--count-blocks', warm: '--warm-blocks' } as const;
const WarmReportSchema = z.object({ blocks: z.int().nonnegative() });

export function createMemoryWarm(deps: Readonly<MemoryWarmDeps>): MemoryWarm {
  const running = new Map<string, RunningWarm>();

  // a sleep that outlasts impd's stop step still ends later and starts a warm
  const lifetime = { isStopped: false };
  const slots = createSemaphore(WARM_CONCURRENCY);

  // the most blocks the cap leaves room for
  const budgetBlocks = Math.floor(deps.capMib / BLOCK_MIB);

  const readBlocks = async (
    mode: HandlerMode,
    target: Readonly<WarmTarget>,
    signal: AbortSignal,
  ): Promise<number> => {
    signal.throwIfAborted();

    const argv = match(mode)
      .with('--warm-blocks', () => [
        deps.handlerBin,
        mode,
        target.blockList,
        target.memFile,
        String(budgetBlocks),
      ])
      .with('--count-blocks', () => [deps.handlerBin, mode, target.blockList, target.memFile])
      .with('--count-data', '--warm', () => [deps.handlerBin, mode, target.memFile])
      .exhaustive();

    const stdout = await runChecked(argv, { signal }, deps.run);

    return WarmReportSchema.parse(JSON.parse(stdout)).blocks;
  };

  const warmRecorded = async (
    target: Readonly<WarmTarget>,
    signal: AbortSignal,
    startedMs: number,
  ): Promise<WarmOutcome> => {
    const recorded = await readBlocks(RECORDED_MODES.count, target, signal);

    // the cap is a budget for recorded blocks, which warm in first-fault order
    // until it is spent
    if (recorded > 0 && budgetBlocks === 0) {
      return { kind: 'overCap', scope: 'recorded', blocks: recorded };
    }

    // the handler refuses a limit of none, and an empty record has nothing to read
    const read = recorded === 0 ? 0 : await readBlocks(RECORDED_MODES.warm, target, signal);

    return {
      kind: 'warmed',
      scope: 'recorded',
      blocks: read,
      scopeBlocks: recorded,
      warmMs: Math.round(performance.now() - startedMs),
    };
  };

  // the cap is a gate for a whole file, which has no order to cut at
  const warmWhole = async (
    target: Readonly<WarmTarget>,
    signal: AbortSignal,
    startedMs: number,
  ): Promise<WarmOutcome> => {
    const counted = await readBlocks(WHOLE_MODES.count, target, signal);

    if (counted * BLOCK_MIB > deps.capMib) {
      return { kind: 'overCap', scope: 'whole', blocks: counted };
    }

    const read = await readBlocks(WHOLE_MODES.warm, target, signal);

    return {
      kind: 'warmed',
      scope: 'whole',
      blocks: read,
      scopeBlocks: counted,
      warmMs: Math.round(performance.now() - startedMs),
    };
  };

  // a record that the handler refuses, at its count or at its warm, counts the
  // same as no record: so does a handler binary that has no limit argument
  const runWarm = async (
    target: Readonly<WarmTarget>,
    signal: AbortSignal,
  ): Promise<WarmOutcome> => {
    const startedMs = performance.now();

    try {
      if (existsSync(target.blockList)) {
        try {
          return await warmRecorded(target, signal, startedMs);
        } catch (error) {
          signal.throwIfAborted();

          getImpdLogger('imps')
            .with({ imp: target.name })
            .warning(
              'the recorded blocks of the memory file cannot be read, so the whole file is: {error}',
              { error: getErrorMessage(error) },
            );
        }
      }

      return await warmWhole(target, signal, startedMs);
    } catch (error) {
      return { kind: 'failed', error: getErrorMessage(error) };
    }
  };

  const stop = async (impID: string, end: WarmEnd): Promise<void> => {
    const warm = running.get(impID);

    if (warm === undefined) {
      return;
    }

    warm.state.end = end;

    warm.controller.abort();

    if (warm.state.phase === 'running') {
      await warm.done;

      return;
    }

    running.delete(impID);

    const warmMs = Math.round(performance.now() - warm.startedMs);

    logWarm(warm.target, { kind: 'ended', end, warmMs }, deps.capMib);
  };

  return {
    start: (target) => {
      if (lifetime.isStopped) {
        logWarm(target, { kind: 'closed' }, deps.capMib);

        return;
      }

      invariant(!running.has(target.impID), `imp ${target.impID} slept with its warm running`);

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

        return runWarm(target, controller.signal);
      };

      const runAndLog = async (): Promise<void> => {
        const outcome = await slots.run(runInSlot);

        if (outcome === null) {
          return;
        }

        running.delete(target.impID);

        const end = state.end;
        const warmMs = Math.round(performance.now() - startedMs);
        const isEnded = outcome.kind === 'failed' && end !== null;
        const logged: WarmOutcome = isEnded ? { kind: 'ended', end, warmMs } : outcome;

        logWarm(target, logged, deps.capMib);
      };

      running.set(target.impID, { target, controller, state, startedMs, done: runAndLog() });
    },
    stop,
    stopAll: async () => {
      lifetime.isStopped = true;

      await Promise.all([...running.keys()].map((impID) => stop(impID, 'impdStopped')));
    },
  };
}

function logWarm(target: Readonly<WarmTarget>, outcome: WarmOutcome, capMib: number): void {
  const logger = getImpdLogger('imps').with({ imp: target.name });

  match(outcome)
    .with({ kind: 'warmed', scope: 'recorded' }, (warmed) => {
      logger.info(
        'warmed {blocks} of {recordedBlocks} recorded blocks ({blocksMib} of {recordedMib} MiB) in {warmMs}ms',
        {
          warmMs: String(warmed.warmMs),
          blocks: String(warmed.blocks),
          recordedBlocks: String(warmed.scopeBlocks),
          blocksMib: String(warmed.blocks * BLOCK_MIB),
          recordedMib: String(warmed.scopeBlocks * BLOCK_MIB),
        },
      );
    })
    .with({ kind: 'warmed', scope: 'whole' }, (warmed) => {
      logger.info('warmed the whole memory file in {warmMs}ms: {blocks} blocks of 2 MiB', {
        warmMs: String(warmed.warmMs),
        blocks: String(warmed.blocks),
      });
    })
    .with({ kind: 'overCap', scope: 'recorded' }, (over) => {
      logger.info(
        'left the memory file cold: not one of its {blocks} recorded blocks of {blockMib} MiB fits the warm cap of {capMib} MiB',
        { blocks: String(over.blocks), blockMib: String(BLOCK_MIB), capMib: String(capMib) },
      );
    })
    .with({ kind: 'overCap', scope: 'whole' }, (over) => {
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
    .with({ kind: 'closed' }, () => {
      logger.info('left the memory file cold: impd is stopping');
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
