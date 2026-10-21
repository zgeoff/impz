import type { ImpRecord } from '../../platform/db/imps';
import { buildBackoffMs } from '../../platform/process/build-backoff-ms';
import { createSingleFlight } from '../../platform/process/single-flight';

const HOUR_MS = 3_600_000;
const FIRST_BACKOFF_MS = 60_000;
const MAX_RECOVERIES_PER_HOUR = 3;

export type WatchdogAction = 'report' | 'restart' | 'snapshot';

interface AgentWatchdogDeps {
  readonly timeoutMs: number;
  readonly action: WatchdogAction;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly confirmSilent: (imp: ImpRecord) => Promise<boolean>;
  readonly recover: (imp: ImpRecord, action: 'restart' | 'snapshot') => Promise<boolean>;
}

export interface AgentWatchdog {
  readonly observe: (imp: ImpRecord, answered: boolean) => void;
  readonly forget: (id: string) => void;
  readonly readSilentSince: (id: string) => Date | null;
  readonly settle: () => Promise<void>;
}

export function createAgentWatchdog(deps: AgentWatchdogDeps): AgentWatchdog {
  const silences = new Map<string, number>();
  const reported = new Set<string>();
  const capped = new Set<string>();
  const recoveries = new Map<string, number[]>();

  const running = createSingleFlight<void>();

  const findNextRecovery = (id: string): number | null => {
    const recent = (recoveries.get(id) ?? []).filter((at) => at > deps.now() - HOUR_MS);

    recoveries.set(id, recent);

    const last = recent.at(-1);

    if (last === undefined) {
      return deps.now();
    }

    if (recent.length >= MAX_RECOVERIES_PER_HOUR) {
      return null;
    }

    return (
      last +
      buildBackoffMs(recent.length, { baseMs: FIRST_BACKOFF_MS, capMs: Number.POSITIVE_INFINITY })
    );
  };

  const removeSilence = (id: string): void => {
    silences.delete(id);
    reported.delete(id);
    capped.delete(id);
  };

  const checkSilence = async (imp: ImpRecord, since: number): Promise<void> => {
    const silent = await deps.confirmSilent(imp);

    if (!silent) {
      removeSilence(imp.id);

      return;
    }

    if (silences.get(imp.id) !== since) {
      return;
    }

    if (!reported.has(imp.id)) {
      reported.add(imp.id);

      const silentS = Math.round((deps.now() - since) / 1000);

      deps.log(
        `impd: ${imp.name}: the agent has not answered for ${String(silentS)}s; its VM still runs (watchdog: ${deps.action})`,
      );
    }

    if (deps.action === 'report') {
      return;
    }

    const next = findNextRecovery(imp.id);

    if (next === null) {
      if (!capped.has(imp.id)) {
        capped.add(imp.id);

        deps.log(
          `impd: ${imp.name}: the watchdog recovered it ${String(MAX_RECOVERIES_PER_HOUR)} times this hour; it only reports now`,
        );
      }

      return;
    }

    if (deps.now() < next) {
      return;
    }

    const startedAt = deps.now();

    const recovered = await deps.recover(imp, deps.action);

    if (recovered) {
      recoveries.get(imp.id)?.push(startedAt);
      removeSilence(imp.id);
    }
  };

  return {
    observe: (imp, answered) => {
      if (answered) {
        if (reported.has(imp.id)) {
          deps.log(`impd: ${imp.name}: the agent answers again`);
        }

        removeSilence(imp.id);

        return;
      }

      const since = silences.get(imp.id) ?? deps.now();

      silences.set(imp.id, since);

      if (deps.now() - since < deps.timeoutMs || running.findRun(imp.id) !== undefined) {
        return;
      }

      void running.run(imp.id, () => checkSilence(imp, since));
    },

    forget: removeSilence,

    readSilentSince: (id) => {
      const since = silences.get(id);

      return since !== undefined && reported.has(id) ? new Date(since) : null;
    },

    settle: () => running.waitForAll(),
  };
}
