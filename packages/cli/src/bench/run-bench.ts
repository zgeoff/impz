import type { ImpEvent, ImpEventDetail } from '@impz/api';
import { ORPCError, watchEvents } from '@impz/client';
import type { ImpClient } from '../config/create-imp-client';
import type { BenchScenario, BenchSettings, BenchSubject } from './bench-scenarios';
import { buildLatencySummary } from './build-latency-summary';
import type { LatencySummary } from './build-latency-summary';

export interface BenchPlan {
  readonly runID: string;
  readonly scenarios: readonly BenchScenario[];
  readonly levels: readonly number[];
  readonly samples: number;
  readonly settings: BenchSettings;
}

export interface BenchDeps {
  readonly client: ImpClient;
  readonly now: () => number;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly onProgress: (line: string) => void;
}

export interface BenchResult {
  readonly scenario: string;
  readonly concurrency: number;
  readonly samples: number;
  readonly failures: Readonly<Record<string, number>>;
  readonly latencyMs: LatencySummary | null;
  readonly impdMs: LatencySummary | null;
  readonly memFileMib: LatencySummary | null;
}

export async function runBench(deps: BenchDeps, plan: Readonly<BenchPlan>): Promise<BenchResult[]> {
  const log = await createEventLog(deps.client);

  const made = new Set<string>();

  const results: BenchResult[] = [];

  try {
    for (const scenario of plan.scenarios) {
      for (const level of plan.levels) {
        const names = Array.from(
          { length: level },
          (_, index) => `bench-${plan.runID}-${String(level)}-${String(index)}`,
        );

        for (const name of names) {
          made.add(name);
        }

        const result = await runLevel(deps, { plan, scenario, names, log });

        results.push(result);
        deps.onProgress(formatProgress(result));

        await removeImps(deps.client, names);
      }
    }
  } finally {
    log.stop();

    await removeImps(deps.client, [...made]);
  }

  return results;
}

interface EventLog {
  readonly events: ImpEvent[];
  readonly stop: () => void;
}

async function createEventLog(client: ImpClient): Promise<EventLog> {
  const events: ImpEvent[] = [];

  const controller = new AbortController();

  const opened = Promise.withResolvers<undefined>();

  const watch = async (): Promise<void> => {
    try {
      await watchEvents(client, {
        signal: controller.signal,
        onOpen: () => opened.resolve(undefined),
        onEvent: (event) => {
          events.push(event);
        },
      });
    } catch (error) {
      opened.reject(error);
    }
  };

  void watch();

  await opened.promise;

  return { events, stop: () => controller.abort() };
}

interface LevelRun {
  readonly plan: Readonly<BenchPlan>;
  readonly scenario: BenchScenario;
  readonly names: readonly string[];
  readonly log: EventLog;
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

  for (let round = 0; round < rounds; round += 1) {
    const subjects = run.names.map((name) => ({
      client: deps.client,
      name,
      settings: run.plan.settings,
      wait: deps.wait,
    }));

    const arranged = await Promise.all(
      subjects.map(async (subject) => {
        try {
          await run.scenario.arrange(subject);

          return subject;
        } catch (error) {
          countFailure(`arrange ${toFailureCode(error)}`);

          return null;
        }
      }),
    );

    const ready = arranged.filter((subject): subject is BenchSubject => subject !== null);
    const mark = run.log.events.length;

    const acted = await Promise.all(
      ready.map(async (subject) => {
        const startedAt = deps.now();

        try {
          await run.scenario.act(subject);

          latencies.push(Math.round(deps.now() - startedAt));

          return subject.name;
        } catch (error) {
          countFailure(toFailureCode(error));

          return null;
        }
      }),
    );

    const details = await waitForDetails(deps, run, {
      mark,
      names: acted.filter((name): name is string => name !== null),
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
  readonly names: readonly string[];
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
      if (
        event.ev === 'ImpChanged' &&
        event.reason === run.scenario.reason &&
        wanted.names.includes(event.imp.name)
      ) {
        found.set(event.imp.name, event.detail ?? {});
      }
    }

    return found;
  };

  for (;;) {
    const found = collect();

    if (found.size === wanted.names.length || deps.now() >= deadline) {
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

async function removeImps(client: ImpClient, names: readonly string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      try {
        await client.imps.destroy({ name });
      } catch (error) {
        if (!(error instanceof ORPCError && error.code === 'NOT_FOUND')) {
          throw error;
        }
      }
    }),
  );
}
