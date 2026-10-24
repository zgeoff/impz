import type { Imps } from './imps/imps/imp-service';
import { getErrorMessage } from './platform/process/get-error-message';
import type { Ticker } from './platform/process/ticker';
import { waitWithin } from './platform/process/wait-within';

// within the 120 s that scripts/dev/dev.sh gives `docker stop`
const STOP_DEADLINE_MS = 100_000;
const STOP_STEP_MAX_MS = 10_000;

// a token exchange under way takes up to 30 s, and its rotated refresh token must be
// stored before the database closes
const STOP_BROKER_MAX_MS = 40_000;

interface Stoppable {
  readonly stop: () => Promise<void>;
}

export interface ImpdStopParts {
  dbWrites?: Stoppable;
  diskUsage?: { readonly stop: () => void };
  tickers?: readonly Ticker[];
  https?: Stoppable | null;
  proxy?: Stoppable;
  broker?: Stoppable;
  egress?: { readonly stop: () => void };
  ssh?: Stoppable | null;
  closeExecSessions?: () => void;
  releaseBuildUploads?: () => void;
  publicMcp?: Stoppable | null;
  api?: { readonly stop: (closeActiveConnections: boolean) => Promise<void> };
  imps?: Pick<Imps, 'sleepAllImps' | 'waitForLifecycle' | 'bootTemplates'>;
  storage?: Stoppable;
  stopTelemetry?: (() => Promise<void>) | null;

  // null leaves a caller's database open
  db?: { readonly destroy: () => Promise<void> } | null;
  readonly log: (message: string) => void;
}

export interface ImpdStopOptions {
  readonly sleepImps: boolean;
  readonly deadlineMs?: number;
  readonly stepMaxMs?: number;
}

type ImpdStopOutcome = 'stopped' | 'timed-out' | 'failed';

export interface ImpdStopStep {
  readonly step: string;
  readonly outcome: ImpdStopOutcome;
}

export async function stopImpd(
  parts: Readonly<ImpdStopParts>,
  options: Readonly<ImpdStopOptions>,
): Promise<readonly ImpdStopStep[]> {
  const deadlineMs = options.deadlineMs ?? STOP_DEADLINE_MS;
  const stepMaxMs = options.stepMaxMs ?? STOP_STEP_MAX_MS;
  const started = performance.now();
  const readLeftMs = () => Math.max(0, deadlineMs - (performance.now() - started));
  const readStepMs = () => Math.min(stepMaxMs, readLeftMs());
  const steps: ImpdStopStep[] = [];

  const runStep = async (
    step: string,
    durationMs: number,
    task: () => Promise<unknown> | void,
  ): Promise<boolean> => {
    try {
      const finished = await waitWithin(Promise.resolve(task()), durationMs);

      if (!finished) {
        parts.log(`impd: stop: ${step} still running after ${String(durationMs)}ms; going on`);
      }

      steps.push({ step, outcome: finished ? 'stopped' : 'timed-out' });

      return finished;
    } catch (error) {
      parts.log(`impd: stop: ${step} failed: ${getErrorMessage(error)}`);
      steps.push({ step, outcome: 'failed' });

      return true;
    }
  };

  // first, so a later write starts no proxy, grant or name sync
  const dbWrites = parts.dbWrites;

  if (dbWrites !== undefined) {
    await runStep('db-writes', readStepMs(), () => dbWrites.stop());
  }

  const diskUsage = parts.diskUsage;

  if (diskUsage !== undefined) {
    await runStep('disk-usage', readStepMs(), () => {
      diskUsage.stop();
    });
  }

  const tickers = parts.tickers;

  if (tickers !== undefined) {
    await runStep('tickers', readStepMs(), () =>
      Promise.all(tickers.map((ticker) => ticker.stop())),
    );
  }

  const https = parts.https;

  if (https !== undefined && https !== null) {
    await runStep('https', readStepMs(), () => https.stop());
  }

  const proxy = parts.proxy;

  if (proxy !== undefined) {
    await runStep('proxy', readStepMs(), () => proxy.stop());
  }

  const broker = parts.broker;

  if (broker !== undefined) {
    await runStep('broker', Math.min(STOP_BROKER_MAX_MS, readLeftMs()), () => broker.stop());
  }

  const egress = parts.egress;

  if (egress !== undefined) {
    await runStep('egress', readStepMs(), () => {
      egress.stop();
    });
  }

  // before the sleep pass, so a client sees its connection end instead of hanging while
  // its imp sleeps
  const ssh = parts.ssh;

  if (ssh !== undefined && ssh !== null) {
    await runStep('ssh', readStepMs(), () => ssh.stop());
  }

  const closeExecSessions = parts.closeExecSessions;

  if (closeExecSessions !== undefined) {
    await runStep('exec-sessions', readStepMs(), () => {
      closeExecSessions();
    });
  }

  const releaseBuildUploads = parts.releaseBuildUploads;

  if (releaseBuildUploads !== undefined) {
    await runStep('build-uploads', readStepMs(), () => {
      releaseBuildUploads();
    });
  }

  const publicMcp = parts.publicMcp;

  if (publicMcp !== undefined && publicMcp !== null) {
    await runStep('public-mcp', readStepMs(), () => publicMcp.stop());
  }

  const api = parts.api;

  if (api !== undefined) {
    await runStep('api', readStepMs(), () => api.stop(true));
  }

  // a wake or boot cut short leaves a Firecracker that no record knows
  const imps = parts.imps;
  const state = { settled: true };

  if (imps !== undefined) {
    state.settled = options.sleepImps
      ? await runStep('sleep', readLeftMs(), () => imps.sleepAllImps())
      : await runStep('lifecycle', readLeftMs(), () => imps.waitForLifecycle());

    await runStep('templates', readStepMs(), () => imps.bootTemplates?.stop());

    if (options.sleepImps) {
      const sleptMs = Math.round(performance.now() - started);

      parts.log(`impd: every imp asleep in ${String(sleptMs)}ms`);
    }
  }

  // a reclaim pass left running would race the next impd's start
  const storage = parts.storage;

  if (storage !== undefined) {
    await runStep('storage', readStepMs(), () => storage.stop());
  }

  // before the database closes, because its gauges read the database
  const stopTelemetry = parts.stopTelemetry;

  if (stopTelemetry !== undefined && stopTelemetry !== null) {
    await runStep('telemetry', readStepMs(), stopTelemetry);
  }

  // a sleep still running writes its record later, and closing the database would fail
  // that write; the next start finds its snapshot
  const db = parts.db;

  if (state.settled && db !== undefined && db !== null) {
    await runStep('database', readStepMs(), () => db.destroy());
  }

  return steps;
}
