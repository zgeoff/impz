import type { Imps } from './imps/imp-service';
import type { Ticker } from './process/ticker';
import { waitWithin } from './process/wait-within';
import { readErrorMessage } from './read-error-message';

// the whole stop, within the 120 s that scripts/dev/dev.sh gives `docker stop`
const STOP_DEADLINE_MS = 100_000;

// at most per step before the sleep pass, which gets whatever is left
const STOP_STEP_MAX_MS = 10_000;

// the broker's stop waits for a token exchange under way (30 s at most) and
// its write, so a rotated refresh token is stored before the database closes
const STOP_BROKER_MAX_MS = 40_000;

interface Stoppable {
  readonly stop: () => Promise<void>;
}

// What impd takes out of service, each part as createImpd started it; null
// for a part the config leaves off
export interface ImpdStopParts {
  // the database writes impd follows, and the work a write started
  readonly dbWrites: Stoppable;
  readonly diskUsage: { readonly stop: () => void };
  readonly tickers: readonly Ticker[];
  readonly https: Stoppable | null;
  readonly proxy: Stoppable;
  readonly broker: Stoppable;
  readonly egress: { readonly stop: () => void };
  readonly ssh: Stoppable | null;
  readonly closeExecSessions: () => void;
  readonly publicMcp: Stoppable | null;
  readonly api: { readonly stop: (closeActiveConnections: boolean) => Promise<void> };
  readonly imps: Pick<Imps, 'sleepAllImps' | 'waitForLifecycle' | 'bootTemplates'>;
  readonly storage: Stoppable;
  readonly stopTelemetry: (() => Promise<void>) | null;

  // the database createImpd opened; null leaves a caller's database open
  readonly db: { readonly destroy: () => Promise<void> } | null;
  readonly log: (message: string) => void;
}

export interface ImpdStopOptions {
  // SIGTERM and SIGINT sleep every running imp; SIGHUP leaves the VMs running
  // for the next impd to adopt
  readonly sleepImps: boolean;

  // the limits above by default
  readonly deadlineMs?: number;
  readonly stepMaxMs?: number;
}

export type ImpdStopOutcome = 'stopped' | 'timed-out' | 'failed';

export interface ImpdStopStep {
  readonly step: string;
  readonly outcome: ImpdStopOutcome;
}

// Takes impd out of service in order, each step bounded, a failure logged:
// the stop always reaches its end. Returns each step it ran, in order. The
// sleep pass gets what is left of the deadline.
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

  // Bounded, and a failure is logged. True when the step finished in time.
  // A ticker stop waits for a pass under way.
  const runStep = async (
    step: string,
    ms: number,
    task: () => Promise<unknown> | void,
  ): Promise<boolean> => {
    try {
      const finished = await waitWithin(Promise.resolve(task()), ms);

      if (!finished) {
        parts.log(`impd: stop: ${step} still running after ${String(ms)}ms; going on`);
      }

      steps.push({ step, outcome: finished ? 'stopped' : 'timed-out' });

      return finished;
    } catch (error) {
      parts.log(`impd: stop: ${step} failed: ${readErrorMessage(error)}`);
      steps.push({ step, outcome: 'failed' });

      return true;
    }
  };

  // first: a write after this point starts no proxy, grant or name sync
  await runStep('db-writes', readStepMs(), () => parts.dbWrites.stop());

  await runStep('disk-usage', readStepMs(), () => {
    parts.diskUsage.stop();
  });

  await runStep('tickers', readStepMs(), () =>
    Promise.all(parts.tickers.map((ticker) => ticker.stop())),
  );

  const https = parts.https;

  if (https !== null) {
    await runStep('https', readStepMs(), () => https.stop());
  }

  await runStep('proxy', readStepMs(), () => parts.proxy.stop());
  await runStep('broker', Math.min(STOP_BROKER_MAX_MS, readLeftMs()), () => parts.broker.stop());

  await runStep('egress', readStepMs(), () => {
    parts.egress.stop();
  });

  // before the sleep pass, as exec sessions are: a client sees its
  // connection end instead of hanging while its imp sleeps
  const ssh = parts.ssh;

  if (ssh !== null) {
    await runStep('ssh', readStepMs(), () => ssh.stop());
  }

  await runStep('exec-sessions', readStepMs(), () => {
    parts.closeExecSessions();
  });

  const publicMcp = parts.publicMcp;

  if (publicMcp !== null) {
    await runStep('public-mcp', readStepMs(), () => publicMcp.stop());
  }

  await runStep('api', readStepMs(), () => parts.api.stop(true));

  // either way, a wake or boot under way finishes first: one cut short
  // leaves a Firecracker that no record knows
  const settled = options.sleepImps
    ? await runStep('sleep', readLeftMs(), () => parts.imps.sleepAllImps())
    : await runStep('lifecycle', readLeftMs(), () => parts.imps.waitForLifecycle());

  // a build cut short leaves a Firecracker no record knows
  await runStep('templates', readStepMs(), () => parts.imps.bootTemplates?.stop());

  if (options.sleepImps) {
    const sleptMs = Math.round(performance.now() - started);

    parts.log(`impd: every imp asleep in ${String(sleptMs)}ms`);
  }

  // a reclaim pass left running would race the next impd's start
  await runStep('storage', readStepMs(), () => parts.storage.stop());

  // sends what the sleep pass recorded; its gauges still read the database
  const stopTelemetry = parts.stopTelemetry;

  if (stopTelemetry !== null) {
    await runStep('telemetry', readStepMs(), stopTelemetry);
  }

  // a sleep still running writes its record later: closing the database
  // under it would fail that write. The next start finds its snapshot.
  const db = parts.db;

  if (settled && db !== null) {
    await runStep('database', readStepMs(), () => db.destroy());
  }

  return steps;
}
