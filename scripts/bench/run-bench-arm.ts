import { join, resolve } from 'node:path';
import { SystemInfoSchema } from '@impz/api';
import type { CommandResult } from '@impz/e2e-harness/instance';
import { waitFor } from '@impz/e2e-harness/wait-for';
import type * as z from 'zod';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import type { DevEnv, DevLayout } from '../lib/build-dev-layout.ts';
import type { DevLock } from '../lib/create-dev-lock.ts';
import { parseJSONOrNull } from '../lib/parse-json-or-null.ts';
import type { BenchArm, BenchArmsArgs } from './parse-bench-arms-args';

type CommandEnv = Readonly<Record<string, string>>;

export interface BenchArmDeps {
  readonly lockDev: (name: string) => DevLock;
  readonly runCommand: (argv: readonly string[], env: CommandEnv) => Promise<CommandResult>;
  readonly writeLog: (path: string, text: string) => void;
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly onStderr: (text: string) => void;
}

export interface ArmRun {
  readonly json: string | null;
  readonly isPassed: boolean;
}

export interface ArmPlan {
  readonly arm: BenchArm;
  readonly commands: Pick<BenchArmsArgs, 'benchArgs' | 'warmUpArgs'>;
  readonly logPath: string;
  readonly impz: string;
  readonly env: DevEnv;
  readonly cwd: string;
}

// dev.sh up reuses a running instance, which may run another checkout, so an
// arm locks the instance's name and then refuses one that runs. A failed log
// read fails the arm only once the instance is down.
export async function runBenchArm(deps: BenchArmDeps, plan: Readonly<ArmPlan>): Promise<ArmRun> {
  const checkout = resolve(plan.cwd, plan.arm.checkout);

  const devEnv = {
    IMP_KERNEL: join(checkout, '.cache', 'ci', 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(checkout, '.cache', 'ci', 'imp-system.squashfs'),
  };

  const layout = buildDevLayout({ env: { ...plan.env, ...devEnv }, root: checkout, cwd: plan.cwd });
  const lock = deps.lockDev(layout.name);

  try {
    const listed = await deps.runCommand(
      [
        layout.containerCLI,
        'ps',
        '-a',
        '--filter',
        `name=^${layout.name}$`,
        '--format',
        '{{.State}}',
      ],
      {},
    );

    if (isDevRunning(listed, layout)) {
      throw new Error(
        `bench arms: ${layout.name} already runs, and dev.sh up would bench it as ${plan.arm.name}; stop it first`,
      );
    }

    const dev = { script: join(checkout, 'scripts', 'dev', 'dev.sh'), env: devEnv };

    return await runLockedArm(deps, { plan, dev, layout });
  } finally {
    releaseLock(deps, lock, layout.name);
  }
}

// docker and podman list no line for a missing container, so only a failed
// list leaves the state unknown
function isDevRunning(listed: Readonly<CommandResult>, layout: DevLayout): boolean {
  if (listed.exitCode !== 0) {
    throw new Error(
      `bench arms: ${layout.containerCLI} ps ${layout.name} exited ${String(listed.exitCode)}: ${listed.stderr}`,
    );
  }

  return listed.stdout.trim() === 'running';
}

interface DevScript {
  readonly script: string;
  readonly env: CommandEnv;
}

interface LockedArm {
  readonly plan: Readonly<ArmPlan>;
  readonly dev: DevScript;
  readonly layout: DevLayout;
}

// A cleanup step that fails is reported and fails the arm, but an earlier
// failure keeps its place as the arm's error, and a finished bench keeps its
// report.
async function runLockedArm(deps: BenchArmDeps, locked: Readonly<LockedArm>): Promise<ArmRun> {
  let ran: ArmRun;
  const cleanupFailures: string[] = [];

  try {
    await runDevChecked(deps, locked.dev, 'up');

    const shownToken = await runDevChecked(deps, locked.dev, 'token');

    // IMP_HOST names a saved host and wins over IMP_URL, so an empty one keeps
    // every command on the dev instance
    const cliEnv = {
      IMP_HOST: '',
      IMP_URL: locked.layout.apiURL,
      IMP_TOKEN: shownToken.trim(),
    };

    ran = await measureArm(deps, locked.plan, cliEnv);
  } finally {
    const logFailure = await writeImpdLog(deps, locked.layout, locked.plan.logPath);
    const downFailure = await stopDev(deps, locked);

    const failures = [logFailure, downFailure].filter((failure) => failure !== null);

    for (const failure of failures) {
      deps.onStderr(`${failure}\n`);
    }

    cleanupFailures.push(...failures);
  }

  return cleanupFailures.length > 0 ? { ...ran, isPassed: false } : ran;
}

async function runDevChecked(
  deps: BenchArmDeps,
  dev: DevScript,
  command: 'up' | 'token',
): Promise<string> {
  const ran = await runDev(deps, dev, command);

  if (ran.exitCode !== 0) {
    throw new Error(`bench arms: dev.sh ${command} exited ${String(ran.exitCode)}`);
  }

  return ran.stdout;
}

function runDev(
  deps: BenchArmDeps,
  dev: DevScript,
  command: 'up' | 'token' | 'down',
): Promise<CommandResult> {
  return deps.runCommand([dev.script, command], dev.env).then((ran) => {
    deps.onStderr(ran.stderr);

    return ran;
  });
}

// A failed bench that finished still prints its report, so its arm keeps its
// numbers.
async function measureArm(
  deps: BenchArmDeps,
  plan: Readonly<ArmPlan>,
  cliEnv: CommandEnv,
): Promise<ArmRun> {
  await waitForInfo(
    deps,
    { impz: plan.impz, env: cliEnv, what: "impd's default image" },
    (info) => (info.defaults?.image ?? null) !== null,
  );

  // the warm-up's creates build the boot template, so every arm's timed
  // run starts with the cache warm
  const warmUp = await deps.runCommand([plan.impz, ...plan.commands.warmUpArgs], cliEnv);

  if (warmUp.exitCode !== 0) {
    throw new Error(`bench arms: the warm-up failed: ${warmUp.stderr}`);
  }

  await waitForInfo(
    deps,
    { impz: plan.impz, env: cliEnv, what: 'the boot template the warm-up built' },
    (info) => (info.host?.bootTemplates ?? 1) > 0,
  );

  const bench = await deps.runCommand(
    [plan.impz, 'bench', ...plan.commands.benchArgs, '--label', plan.arm.name, '--json'],
    cliEnv,
  );

  deps.onStderr(bench.stderr);

  return {
    json: bench.stdout.trim() === '' ? null : bench.stdout,
    isPassed: bench.exitCode === 0,
  };
}

const ReadinessSchema = SystemInfoSchema.pick({ defaults: true, host: true });
const READY_TIMEOUT_MS = 600_000;
const POLL_MS = 2000;

interface InfoWait {
  readonly impz: string;
  readonly env: CommandEnv;
  readonly what: string;
}

async function waitForInfo(
  deps: BenchArmDeps,
  wait: Readonly<InfoWait>,
  isReady: (info: z.infer<typeof ReadinessSchema>) => boolean,
): Promise<void> {
  await waitFor(
    `bench arms: ${wait.what}`,
    async () => {
      const shown = await deps.runCommand([wait.impz, 'info', '--json'], wait.env);

      if (shown.exitCode !== 0) {
        throw new Error(`impz info exited ${String(shown.exitCode)}: ${shown.stderr}`);
      }

      const parsed = ReadinessSchema.safeParse(parseJSONOrNull(shown.stdout));

      if (!parsed.success || !isReady(parsed.data)) {
        throw new Error('impd is not ready yet');
      }
    },
    { intervalMs: POLL_MS, timeoutMs: READY_TIMEOUT_MS, now: deps.now, wait: deps.sleep },
  );
}

async function writeImpdLog(
  deps: BenchArmDeps,
  layout: DevLayout,
  logPath: string,
): Promise<string | null> {
  let logs: CommandResult;

  try {
    logs = await deps.runCommand([layout.containerCLI, 'logs', layout.name], {});

    deps.writeLog(logPath, `${logs.stdout}${logs.stderr}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return `bench arms: could not save the impd log to ${logPath}: ${reason}`;
  }

  return logs.exitCode === 0
    ? null
    : `bench arms: ${layout.containerCLI} logs ${layout.name} exited ${String(logs.exitCode)}, so ${logPath} holds no impd log`;
}

// a down that cannot start counts as one that failed, so it never hides the
// arm's own error
async function stopDev(deps: BenchArmDeps, locked: Readonly<LockedArm>): Promise<string | null> {
  const stillRuns = `so ${locked.layout.name} may still run`;
  let down: CommandResult;

  try {
    down = await runDev(deps, locked.dev, 'down');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return `bench arms: dev.sh down could not run (${reason}), ${stillRuns}`;
  }

  return down.exitCode === 0
    ? null
    : `bench arms: dev.sh down exited ${String(down.exitCode)}, ${stillRuns}`;
}

// a lock left behind refuses the next bench with its path, so a failed
// release is reported and never replaces the arm's own error
function releaseLock(deps: BenchArmDeps, lock: DevLock, name: string): void {
  try {
    lock.release();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    deps.onStderr(`bench arms: could not release the lock on ${name}: ${reason}\n`);
  }
}
