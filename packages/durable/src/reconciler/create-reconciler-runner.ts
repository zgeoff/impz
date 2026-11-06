import invariant from 'tiny-invariant';
import { createActor, toPromise } from 'xstate';
import type { Actor, ActorOptions } from 'xstate';
import type { DurableQueries } from '../durable-tables';
import type { DurableLog, OperationRunner } from '../operations/create-operation-runner';
import { buildBackoffDelayMs } from './build-backoff-delay-ms';
import type { ReconcileResult, ReconcilerDefinition } from './define-reconciler';
import { readReconcilerResults } from './read-reconciler-results';
import type { ReconcilerResult } from './read-reconciler-results';
import { reconcilerMachine } from './reconciler-machine';
import { writeReconcilerResult } from './write-reconciler-result';

export type ReconcilerTimer = (fire: () => void, delayMs: number) => () => void;

export interface ReconcilerRunnerDeps<TTrx extends DurableQueries> {
  readonly reconcilers: readonly ReconcilerDefinition<TTrx>[];
  readonly withTransaction: <T>(run: (trx: TTrx) => Promise<T>) => Promise<T>;
  readonly startOperation: OperationRunner<TTrx>['start'];
  readonly log: DurableLog;
  readonly now: () => number;
  readonly random: () => number;
  readonly startTimer: ReconcilerTimer;
}

export interface ReconcilerStatus {
  readonly name: string;
  readonly intervalMs: number;
  readonly last: ReconcilerResult | null;
  readonly running: boolean;
  readonly nextRunAt: number | null;
}

export interface ReconcilerRunner {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly trigger: (name: string) => void;
  readonly list: () => ReconcilerStatus[];
}

interface Entry<TTrx extends DurableQueries> {
  readonly definition: ReconcilerDefinition<TTrx>;
  readonly actor: Actor<typeof reconcilerMachine>;
  last: ReconcilerResult | null;
  savedOutcome: ReconcilerResult['outcome'] | null;
  nextRunAt: number | null;
}

export function createReconcilerRunner<TTrx extends DurableQueries>(
  deps: ReconcilerRunnerDeps<TTrx>,
): ReconcilerRunner {
  const controller = new AbortController();

  const clock = toMachineClock(deps.startTimer);

  const entries = new Map<string, Entry<TTrx>>();

  const runPass = async (entry: Entry<TTrx>, consecutiveErrors: number): Promise<void> => {
    const passed = await runReconcile(entry.definition);

    const errors = passed.outcome === 'error' ? consecutiveErrors + 1 : 0;

    const result = {
      name: entry.definition.name,
      ...passed,
      consecutiveErrors: errors,
      at: deps.now(),
    };

    entry.last = result;

    if (entry.savedOutcome !== result.outcome) {
      const saved = await writeResult(result);

      entry.savedOutcome = saved ? result.outcome : entry.savedOutcome;
    }

    entry.actor.send({ type: 'passed', consecutiveErrors: errors });
  };

  const runReconcile = async (
    definition: ReconcilerDefinition<TTrx>,
  ): Promise<Pick<ReconcilerResult, 'outcome' | 'summary'>> => {
    try {
      const result: ReconcileResult = await definition.reconcile({
        signal: controller.signal,
        log: deps.log,
        startOperation: deps.startOperation,
      });

      return result;
    } catch (error) {
      deps.log.warning('reconciler {name} failed: {error}', {
        name: definition.name,
        error: toErrorMessage(error),
      });

      return { outcome: 'error', summary: toErrorMessage(error) };
    }
  };

  const writeResult = async (result: ReconcilerResult): Promise<boolean> => {
    try {
      await deps.withTransaction((trx) => writeReconcilerResult(trx, result));

      return true;
    } catch (error) {
      deps.log.warning('the result of reconciler {name} was not saved: {error}', {
        name: result.name,
        error: toErrorMessage(error),
      });

      return false;
    }
  };

  const createEntry = (
    definition: ReconcilerDefinition<TTrx>,
    saved: ReconcilerResult | undefined,
  ): Entry<TTrx> => {
    const actor = createActor(reconcilerMachine, {
      clock,
      input: {
        startPass: (consecutiveErrors) => {
          void runPass(entry, consecutiveErrors);
        },
        pickDelayMs: (consecutiveErrors) =>
          buildBackoffDelayMs(definition.intervalMs, consecutiveErrors, deps.random()),
      },
    });

    const entry: Entry<TTrx> = {
      definition,
      actor,
      last: saved ?? null,
      savedOutcome: saved?.outcome ?? null,
      nextRunAt: null,
    };

    actor.subscribe((snapshot) => {
      entry.nextRunAt = snapshot.value === 'waiting' ? deps.now() + snapshot.context.delayMs : null;
    });

    return entry;
  };

  return {
    start: async () => {
      invariant(entries.size === 0, 'the reconciler runner has already started');

      const saved = await deps.withTransaction((trx) => readReconcilerResults(trx));

      for (const definition of deps.reconcilers) {
        invariant(!entries.has(definition.name), `two reconcilers are named ${definition.name}`);

        entries.set(
          definition.name,
          createEntry(
            definition,
            saved.find((result) => result.name === definition.name),
          ),
        );
      }

      for (const entry of entries.values()) {
        entry.actor.start();
      }
    },
    stop: async () => {
      controller.abort();

      for (const entry of entries.values()) {
        entry.actor.send({ type: 'stop' });
      }

      await Promise.all([...entries.values()].map((entry) => toPromise(entry.actor)));
    },
    trigger: (name) => {
      const entry = entries.get(name);

      invariant(entry !== undefined, `no reconciler is named ${name}`);

      entry.actor.send({ type: 'trigger' });
    },
    list: () =>
      [...entries.values()].map((entry) => ({
        name: entry.definition.name,
        intervalMs: entry.definition.intervalMs,
        last: entry.last,
        running: entry.actor.getSnapshot().value === 'running',
        nextRunAt: entry.nextRunAt,
      })),
  };
}

type MachineClock = NonNullable<ActorOptions<typeof reconcilerMachine>['clock']>;

function toMachineClock(startTimer: ReconcilerTimer): MachineClock {
  const cancels = new Map<number, () => void>();

  const ids = { next: 0 };

  return {
    setTimeout: (fire: () => void, timeoutMs: number) => {
      ids.next += 1;

      const id = ids.next;

      cancels.set(
        id,
        startTimer(() => {
          cancels.delete(id);

          fire();
        }, timeoutMs),
      );

      return id;
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === 'number') {
        cancels.get(id)?.();
        cancels.delete(id);
      }
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
