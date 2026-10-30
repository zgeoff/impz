import type { Imp, ImpEvent, ImpEventDetail } from '@impz/api';
import { ORPCError } from '@impz/client';
import type { watchEvents } from '@impz/client';
import type { ImpClient } from '../config/create-imp-client';
import type { BenchResult } from './bench-report-schema';
import type { BenchScenario, BenchSettings } from './bench-scenarios';
import { buildLatencySummary } from './build-latency-summary';
import { isStepEvent } from './is-step-event';

export interface BenchPlan {
  readonly runID: string;
  readonly scenarios: readonly BenchScenario[];
  readonly levels: readonly number[];
  readonly samples: number;
  readonly settings: BenchSettings;
}

export interface BenchDeps {
  readonly client: ImpClient;
  readonly watchEvents: typeof watchEvents;
  readonly now: () => number;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly onProgress: (line: string) => void;

  // an abort stops the bench between rounds; it still removes what it made
  readonly signal?: AbortSignal;
}

export async function runBench(deps: BenchDeps, plan: Readonly<BenchPlan>): Promise<BenchResult[]> {
  const prefix = `bench-${plan.runID}-`;

  const taken = await deps.client.imps.list();

  if (taken.some((imp) => imp.name.startsWith(prefix))) {
    throw new Error(`bench: imps named ${prefix}* already exist, so this run would not own them`);
  }

  const log = await createEventLog(deps);

  const owned = new Set<string>();

  const results: BenchResult[] = [];
  let cleanupFailure: Error | null = null;

  try {
    for (const scenario of plan.scenarios) {
      for (const level of plan.levels) {
        if (deps.signal?.aborted === true) {
          break;
        }

        const names = Array.from(
          { length: level },
          (_, index) => `${prefix}${String(level)}-${String(index)}`,
        );

        const result = await runLevel(deps, { plan, scenario, names, log, owned });

        results.push(result);
        deps.onProgress(formatProgress(result));

        const leftover = await removeOwned(deps, owned, names);

        if (leftover !== null) {
          throw leftover;
        }
      }
    }
  } finally {
    log.stop();

    cleanupFailure = await removeOwned(deps, owned, [...owned]);
  }

  if (cleanupFailure !== null) {
    throw cleanupFailure;
  }

  if (deps.signal?.aborted === true) {
    throw new Error('bench: stopped by a signal, and removed the imps it made');
  }

  if (log.failure !== null) {
    throw new Error(`bench: impd's event stream failed, so its figures are incomplete`, {
      cause: log.failure.error,
    });
  }

  return results;
}

interface EventLog {
  readonly events: ImpEvent[];
  readonly stop: () => void;

  // a stream that fails after it opened, which a bench must not report as complete
  failure: { readonly error: unknown } | null;
}

async function createEventLog(deps: Readonly<BenchDeps>): Promise<EventLog> {
  const controller = new AbortController();

  const opened = Promise.withResolvers<undefined>();

  const log: EventLog = {
    events: [],
    failure: null,
    stop: () => {
      controller.abort();
    },
  };

  const watch = async (): Promise<void> => {
    try {
      await deps.watchEvents(deps.client, {
        signal: controller.signal,
        onOpen: () => {
          opened.resolve(undefined);
        },
        onEvent: (event) => {
          log.events.push(event);
        },
      });

      // impd may end the stream cleanly, which leaves the run without figures
      // all the same; only the bench's own stop ends it on purpose
      throw new Error("impd's event stream ended");
    } catch (error) {
      if (!controller.signal.aborted) {
        log.failure = { error };
      }

      opened.reject(error);
    }
  };

  void watch();

  await opened.promise;

  return log;
}

interface LevelRun {
  readonly plan: Readonly<BenchPlan>;
  readonly scenario: BenchScenario;
  readonly names: readonly string[];
  readonly log: EventLog;
  readonly owned: Set<string>;
}

async function runLevel(deps: BenchDeps, run: Readonly<LevelRun>): Promise<BenchResult> {
  const rounds = Math.ceil(run.plan.samples / run.names.length);
  const latencies: number[] = [];
  const impdMs: number[] = [];
  const memFileMib: number[] = [];

  const failures = new Map<string, number>();

  const countFailure = (code: string): void => {
    failures.set(code, (failures.get(code) ?? 0) + 1);
  };

  for (let round = 0; round < rounds && deps.signal?.aborted !== true; round += 1) {
    const subjects = run.names.map((name) => ({
      client: deps.client,
      name,
      settings: run.plan.settings,
      wait: deps.wait,
      owned: run.owned,
    }));

    const arranged = await Promise.all(
      subjects.map(async (subject) => {
        try {
          const step = await run.scenario.arrange(subject);

          return { name: subject.name, step };
        } catch (error) {
          countFailure(`arrange ${toFailureCode(error)}`);

          return null;
        }
      }),
    );

    const ready = arranged.filter((prepared) => prepared !== null);
    const mark = run.log.events.length;

    const acted = await Promise.all(
      ready.map(async (prepared) => {
        const startedAt = deps.now();

        try {
          const stepped = await prepared.step();

          latencies.push(Math.round(deps.now() - startedAt));

          return stepped;
        } catch (error) {
          countFailure(toFailureCode(error));

          return null;
        }
      }),
    );

    const details = await waitForDetails(deps, run, {
      mark,
      stepped: acted.filter((imp) => imp !== null),
    });

    for (const detail of details) {
      if (detail.durationMs !== undefined) {
        impdMs.push(detail.durationMs);
      }

      if (detail.memFileMib !== undefined) {
        memFileMib.push(detail.memFileMib);
      }
    }
  }

  return {
    scenario: run.scenario.name,
    concurrency: run.names.length,
    samples: latencies.length,
    failures: Object.fromEntries(failures),
    latencyMs: buildLatencySummary(latencies),
    impdMs: buildLatencySummary(impdMs),
    memFileMib: buildLatencySummary(memFileMib),
  };
}

function toFailureCode(error: unknown): string {
  return error instanceof ORPCError ? String(error.code) : 'ERROR';
}

interface DetailWait {
  readonly mark: number;
  readonly stepped: readonly Imp[];
}

// impd sends a change event after the call that made the change returns, so
// a round waits this long for each event before it reports no impd figure
const EVENT_WAIT_MS = 3000;
const EVENT_POLL_MS = 20;

async function waitForDetails(
  deps: BenchDeps,
  run: Readonly<LevelRun>,
  wanted: Readonly<DetailWait>,
): Promise<ImpEventDetail[]> {
  const deadline = deps.now() + EVENT_WAIT_MS;

  const collect = (): Map<string, ImpEventDetail> => {
    const found = new Map<string, ImpEventDetail>();

    for (const event of run.log.events.slice(wanted.mark)) {
      const stepped = wanted.stepped.find((imp) => isStepEvent(event, run.scenario.reason, imp));

      if (stepped !== undefined && event.ev === 'ImpChanged') {
        found.set(stepped.id, event.detail ?? {});
      }
    }

    return found;
  };

  for (;;) {
    const found = collect();
    const isStreamDown = run.log.failure !== null;

    if (found.size === wanted.stepped.length || isStreamDown || deps.now() >= deadline) {
      return [...found.values()];
    }

    await deps.wait(EVENT_POLL_MS);
  }
}

function formatProgress(result: Readonly<BenchResult>): string {
  const latency = result.latencyMs;

  const figures =
    latency === null
      ? 'no sample'
      : `p50 ${String(latency.p50)}ms, p95 ${String(latency.p95)}ms, p99 ${String(latency.p99)}ms`;

  const failed = Object.values(result.failures).reduce((sum, count) => sum + count, 0);

  return `bench: ${result.scenario} at ${String(result.concurrency)}: ${figures} over ${String(result.samples)} samples, ${String(failed)} failed`;
}

// Every destroy runs to its end, so one failure leaves no other removal in
// flight; each failure is reported, and the run fails once on them all.
async function removeOwned(
  deps: Readonly<BenchDeps>,
  owned: Set<string>,
  names: readonly string[],
): Promise<Error | null> {
  const failed: string[] = [];

  const removals = await Promise.allSettled(
    names
      .filter((name) => owned.has(name))
      .map(async (name) => {
        try {
          await deps.client.imps.destroy({ name });
        } catch (error) {
          if (!(error instanceof ORPCError && error.code === 'NOT_FOUND')) {
            const reason = error instanceof Error ? error.message : String(error);

            failed.push(name);
            deps.onProgress(`bench: could not remove ${name}: ${reason}`);
            throw error;
          }
        }

        owned.delete(name);
      }),
  );

  const errors = removals.flatMap((removal): unknown[] =>
    removal.status === 'rejected' ? [removal.reason] : [],
  );

  return errors.length === 0
    ? null
    : new AggregateError(
        errors,
        `bench: could not remove ${failed.join(', ')}, so they are left on the host`,
      );
}
