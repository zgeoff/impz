import { join, resolve } from 'node:path';
import { SystemInfoSchema } from '@impz/api';
import type * as z from 'zod';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import type { ContainerCLI, DevLayout } from '../lib/build-dev-layout.ts';
import type { DevLock } from '../lib/create-dev-lock.ts';
import { parseJSONOrNull } from '../lib/parse-json-or-null.ts';
import type { BenchArm, BenchArmsArgs } from './parse-bench-arms-args';

type DevCommand = 'up' | 'token' | 'down';

type Env = Readonly<Record<string, string | undefined>>;

export interface CommandRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ImpdLogs {
  readonly exitCode: number;
  readonly output: Uint8Array;
}

export interface BenchArmDeps {
  readonly lockDev: (name: string) => DevLock;
  readonly inspectDev: (cli: ContainerCLI, name: string) => Promise<CommandRun>;
  readonly runDev: (script: string, command: DevCommand, env: Env) => Promise<string>;
  readonly runImpz: (args: readonly string[], env: Env) => Promise<CommandRun>;
  readonly readImpdLogs: (cli: ContainerCLI, name: string) => Promise<ImpdLogs>;
  readonly writeLog: (path: string, output: Uint8Array) => void;
  readonly now: () => number;
  readonly wait: (durationMs: number) => Promise<void>;
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
  readonly env: Env;
  readonly cwd: string;
}

// dev.sh up reuses a running instance, which may run another checkout, so an
// arm locks the instance's name and then refuses one that runs. A failed log
// read fails the arm only once the instance is down.
export async function runBenchArm(deps: BenchArmDeps, plan: Readonly<ArmPlan>): Promise<ArmRun> {
  const checkout = resolve(plan.cwd, plan.arm.checkout);
  const dev = join(checkout, 'scripts', 'dev', 'dev.sh');

  const devEnv = {
    ...plan.env,
    IMP_KERNEL: join(checkout, '.cache', 'ci', 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(checkout, '.cache', 'ci', 'imp-system.squashfs'),
  };

  const layout = buildDevLayout({ env: devEnv, root: checkout, cwd: plan.cwd });
  const lock = deps.lockDev(layout.name);

  try {
    const inspected = await deps.inspectDev(layout.containerCLI, layout.name);

    if (isDevRunning(inspected, layout)) {
      throw new Error(
        `bench arms: ${layout.name} already runs, and dev.sh up would bench it as ${plan.arm.name}; stop it first`,
      );
    }

    return await runLockedArm(deps, { plan, dev, devEnv, layout });
  } finally {
    lock.release();
  }
}

// docker and podman both name a missing container "no such object" or
// "no such container"; any other failed inspect leaves the state unknown
function isDevRunning(inspected: Readonly<CommandRun>, layout: DevLayout): boolean {
  if (inspected.exitCode === 0) {
    return inspected.stdout.trim() === 'true';
  }

  if (/no such (?:object|container)/iu.test(inspected.stderr)) {
    return false;
  }

  throw new Error(
    `bench arms: ${layout.containerCLI} inspect ${layout.name} exited ${String(inspected.exitCode)}: ${inspected.stderr}`,
  );
}

interface LockedArm {
  readonly plan: Readonly<ArmPlan>;
  readonly dev: string;
  readonly devEnv: Env;
  readonly layout: DevLayout;
}

async function runLockedArm(deps: BenchArmDeps, locked: Readonly<LockedArm>): Promise<ArmRun> {
  let ran: ArmRun;
  let logFailure: string | null = null;

  try {
    await deps.runDev(locked.dev, 'up', locked.devEnv);

    const shownToken = await deps.runDev(locked.dev, 'token', locked.devEnv);

    const cliEnv = {
      ...locked.plan.env,
      IMP_URL: locked.layout.apiURL,
      IMP_TOKEN: shownToken.trim(),
    };

    ran = await measureArm(deps, locked.plan, cliEnv);
  } finally {
    try {
      logFailure = await writeImpdLog(deps, locked.layout, locked.plan.logPath);
    } finally {
      await deps.runDev(locked.dev, 'down', locked.devEnv);
    }
  }

  if (logFailure !== null) {
    throw new Error(logFailure);
  }

  return ran;
}

// A failed bench that finished still prints its report, so its arm keeps its
// numbers.
async function measureArm(
  deps: BenchArmDeps,
  plan: Readonly<ArmPlan>,
  cliEnv: Env,
): Promise<ArmRun> {
  await waitForInfo(deps, cliEnv, (info) => info.defaults?.image !== null);

  // the warm-up's creates build the boot template, so every arm's timed
  // run starts with the cache warm
  const warmUp = await deps.runImpz(plan.commands.warmUpArgs, cliEnv);

  if (warmUp.exitCode !== 0) {
    throw new Error(`bench arms: the warm-up failed: ${warmUp.stderr}`);
  }

  await waitForInfo(deps, cliEnv, (info) => (info.host?.bootTemplates ?? 1) > 0);

  const bench = await deps.runImpz(
    ['bench', ...plan.commands.benchArgs, '--label', plan.arm.name, '--json'],
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

async function waitForInfo(
  deps: BenchArmDeps,
  env: Env,
  isReady: (info: z.infer<typeof ReadinessSchema>) => boolean,
): Promise<void> {
  const deadline = deps.now() + READY_TIMEOUT_MS;

  for (;;) {
    const shown = await deps.runImpz(['info', '--json'], env);

    const info = shown.exitCode === 0 ? parseJSONOrNull(shown.stdout) : null;
    const parsed = ReadinessSchema.safeParse(info);

    if (parsed.success && isReady(parsed.data)) {
      return;
    }

    if (deps.now() >= deadline) {
      throw new Error('bench arms: impd never got ready to bench');
    }

    await deps.wait(POLL_MS);
  }
}

async function writeImpdLog(
  deps: BenchArmDeps,
  layout: DevLayout,
  logPath: string,
): Promise<string | null> {
  const logs = await deps.readImpdLogs(layout.containerCLI, layout.name);

  deps.writeLog(logPath, logs.output);

  return logs.exitCode === 0
    ? null
    : `bench arms: ${layout.containerCLI} logs ${layout.name} exited ${String(logs.exitCode)}, so ${logPath} holds no impd log`;
}
