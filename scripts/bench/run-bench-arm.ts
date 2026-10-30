import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SystemInfoSchema } from '@impz/api';
import type * as z from 'zod';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import type { ContainerCLI, DevLayout } from '../lib/build-dev-layout.ts';
import type { BenchArm, BenchArmsArgs } from './parse-bench-arms-args';

type DevCommand = 'up' | 'token' | 'down';

type Env = Readonly<Record<string, string | undefined>>;

export interface ImpzRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ImpdLogs {
  readonly exitCode: number;
  readonly output: Uint8Array;
}

export interface BenchArmDeps {
  readonly probeDevRunning: (cli: ContainerCLI, name: string) => Promise<boolean>;
  readonly runDev: (script: string, command: DevCommand, env: Env) => Promise<string>;
  readonly runImpz: (args: readonly string[], env: Env) => Promise<ImpzRun>;
  readonly readImpdLogs: (cli: ContainerCLI, name: string) => Promise<ImpdLogs>;
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
}

// dev.sh up reuses a running instance, which may run another checkout, so an
// arm refuses one rather than bench it under its own name. A failed log read
// fails the arm only once the dev instance is down.
export async function runBenchArm(deps: BenchArmDeps, plan: Readonly<ArmPlan>): Promise<ArmRun> {
  const checkout = resolve(plan.arm.checkout);
  const dev = join(checkout, 'scripts', 'dev', 'dev.sh');

  const devEnv = {
    ...process.env,
    IMP_KERNEL: join(checkout, '.cache', 'ci', 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(checkout, '.cache', 'ci', 'imp-system.squashfs'),
  };

  const layout = buildDevLayout({ env: devEnv, root: checkout, cwd: process.cwd() });

  const isTaken = await deps.probeDevRunning(layout.containerCLI, layout.name);

  if (isTaken) {
    throw new Error(
      `bench arms: ${layout.name} already runs, and dev.sh up would bench it as ${plan.arm.name}; stop it first`,
    );
  }

  let ran: ArmRun;
  let logFailure: string | null = null;

  try {
    await deps.runDev(dev, 'up', devEnv);

    const cliEnv = await readCLIEnv(deps, dev, devEnv, layout);

    ran = await measureArm(deps, plan, cliEnv);
  } finally {
    try {
      logFailure = await writeImpdLog(deps, layout, plan.logPath);
    } finally {
      await deps.runDev(dev, 'down', devEnv);
    }
  }

  if (logFailure !== null) {
    throw new Error(logFailure);
  }

  return ran;
}

async function readCLIEnv(
  deps: BenchArmDeps,
  dev: string,
  devEnv: Env,
  layout: DevLayout,
): Promise<Env> {
  const shownToken = await deps.runDev(dev, 'token', devEnv);

  return { ...process.env, IMP_URL: layout.apiURL, IMP_TOKEN: shownToken.trim() };
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
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    const shown = await deps.runImpz(['info', '--json'], env);

    const parsed = ReadinessSchema.safeParse(parseJSONOrNull(shown));

    if (parsed.success && isReady(parsed.data)) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error('bench arms: impd never got ready to bench');
    }

    await deps.wait(POLL_MS);
  }
}

function parseJSONOrNull(shown: Readonly<ImpzRun>): unknown {
  if (shown.exitCode !== 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(shown.stdout);

    return parsed;
  } catch {
    return null;
  }
}

async function writeImpdLog(
  deps: BenchArmDeps,
  layout: DevLayout,
  logPath: string,
): Promise<string | null> {
  const logs = await deps.readImpdLogs(layout.containerCLI, layout.name);

  writeFileSync(logPath, logs.output);

  return logs.exitCode === 0
    ? null
    : `bench arms: ${layout.containerCLI} logs ${layout.name} exited ${String(logs.exitCode)}, so ${logPath} holds no impd log`;
}
