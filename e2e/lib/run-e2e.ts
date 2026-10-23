import { join } from 'node:path';
import { collectBootFallbacks } from './boot-fallbacks';
import { buildHarnessEnv } from './build-harness-env';
import { buildConfig } from './config';
import type { E2EConfig, HarnessEnv } from './config';
import type { DevInstance } from './instance';
import type { HostBFixture } from './move-hosts';
import type { HarnessArgs } from './parse-args';
import { parseArgs } from './parse-args';
import { hasRunPassed, runSuites } from './run-suites';
import {
  FAST_GROUPS,
  SUITES,
  buildJourneyArgv,
  buildJourneyEnv,
  listJourneys,
  readSuiteSettings,
} from './suites';
import type { TailscaleE2EKey } from './tailscale-key';
import type { ResultsOptions, Section } from './write-results';

export interface HarnessRun {
  readonly args: HarnessArgs;
  readonly env: HarnessEnv;
  readonly config: E2EConfig;
}

interface JourneyRequest {
  readonly argv: readonly string[];
  readonly env: HarnessEnv;
  readonly onStart: (pid: number) => void;
}

export interface HarnessDeps {
  readonly readHostImage: (env: HarnessEnv) => string;
  readonly readTailscaleKey: (env: HarnessEnv) => Promise<TailscaleE2EKey | null>;

  readonly setUpInstance: (run: Readonly<HarnessRun>) => Promise<DevInstance>;
  readonly recreateInstance: (run: Readonly<HarnessRun>) => Promise<DevInstance>;
  readonly resetSuites: (prefixes: readonly string[], target: DevInstance) => Promise<void>;

  readonly rebootInstance: (
    target: DevInstance,
    settings: Readonly<Record<string, string>>,
    env: HarnessEnv,
  ) => Promise<void>;

  readonly runJourney: (request: Readonly<JourneyRequest>) => Promise<number>;
  readonly stopJourney: (pid: number, signal: NodeJS.Signals) => void;
  readonly readImpdLogTail: (target: DevInstance) => Promise<string>;
  readonly readImpdLogSince: (since: Readonly<Date>, target: DevInstance) => Promise<string>;
  readonly readHostBFixture: (fixture: string, run: Readonly<HarnessRun>) => HostBFixture;

  readonly removeLeftovers: (
    suites: readonly string[],
    target: DevInstance,
    env: HarnessEnv,
  ) => Promise<void>;

  readonly stopPebble: () => Promise<void>;
  readonly createDirectory: (path: string) => void;
  readonly removeFile: (path: string) => void;

  readonly writeResults: (sections: readonly Section[], options: Readonly<ResultsOptions>) => void;

  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  readonly exit: (code: number) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

interface RunE2EOptions {
  readonly argv: readonly string[];
  readonly env: HarnessEnv;
  readonly bunPath: string;
  readonly resultsDir: string;
  readonly deps: HarnessDeps;
}

const USAGE = `imp end-to-end harness: every case drives impd through the CLI.

  e2e/test-e2e.sh [--only SUITES | --group N] [--clean | --reuse] [--keep]

  --only    comma-separated suites or sets (default: acceptance)
            suites: ${SUITES.map((suite) => suite.name).join(' ')}
            sets:   acceptance (all, tailscale required), fast (the CI subset)
  --group   one of the fast set's ${String(FAST_GROUPS.length)} CI groups, 1 to ${String(FAST_GROUPS.length)}
  --clean   full reset first: tailnet logout, remove the dev container, wipe
            its data dir (XFS file, db, images, imps, checkpoints), and the
            moves suites' second host and its data dir
  --reuse   keep a running dev instance instead of restarting it
  --keep    leave the run's imps and images in place

Env: IMP_DEV_NAME, IMP_DEV_PORT_OFFSET, IMP_DEV_DATA pick the dev instance
(scripts/dev/dev.sh). E2E_RAM_BUDGET_MIB (6144) and E2E_IDLE_TIMEOUT_S (10) tune
impd; E2E_SCALE_COUNT (30), E2E_SCALE_MEMORY_MIB (512), E2E_SCALE_FILL_MIB
(256), E2E_MAX_NEW_MS (3000), E2E_MAX_CHECKPOINT_MS (500) tune the suites.

Writes .cache/e2e/results.json. Exits non-zero if any suite fails.`;

const PREFIX = 'e2e-';

interface RunState {
  interrupted: boolean;
  running: number | null;
}

export async function runE2E(options: Readonly<RunE2EOptions>): Promise<number> {
  const deps = options.deps;
  let args: HarnessArgs;

  try {
    args = parseArgs(options.argv);
  } catch (error) {
    deps.warn(`test-e2e: ${formatReason(error)}\n`);
    deps.warn(USAGE);

    return 2;
  }

  if (args.help) {
    deps.log(USAGE);

    return 0;
  }

  const config = buildConfig(options.env);
  const hostImage = deps.readHostImage(options.env);
  const isTailnetRun = args.suites.includes('tailscale') || args.suites.includes('moves-tailnet');
  const tailnet = isTailnetRun ? await deps.readTailscaleKey(options.env) : null;

  const run: HarnessRun = {
    args,
    config,
    env: buildHarnessEnv({ env: options.env, hostImage, config, tailnet }),
  };

  const resultsFile = join(options.resultsDir, 'results.json');
  const metricsFile = join(options.resultsDir, 'metrics.jsonl');
  const state: RunState = { interrupted: false, running: null };
  const started: { instance: DevInstance | null } = { instance: null };

  const stopRun = (signal: NodeJS.Signals): void => {
    if (state.interrupted) {
      deps.exit(130);

      return;
    }

    state.interrupted = true;

    if (state.running !== null) {
      deps.stopJourney(state.running, signal);
    }
  };

  deps.onSignal('SIGINT', () => {
    stopRun('SIGINT');
  });

  deps.onSignal('SIGTERM', () => {
    stopRun('SIGTERM');
  });

  deps.createDirectory(options.resultsDir);
  deps.removeFile(metricsFile);

  const setup = await runTimed(deps, 'setup', async () => {
    started.instance = await deps.setUpInstance(run);

    return true;
  });

  const sections: Section[] = [setup];
  let stoppedBecause: string | null = null;

  if (started.instance !== null) {
    const ready: { current: DevInstance } = { current: started.instance };

    const startedAt = new Map<string, Date>();

    const runJourneyProcess = async (
      journey: string,
      kept: readonly string[],
      settings: Readonly<Record<string, string>> | null,
    ): Promise<number> => {
      startedAt.set(journey, new Date(deps.now()));

      const exitCode = await deps.runJourney({
        argv: buildJourneyArgv(options.bunPath, journey),
        env: {
          ...run.env,
          IMP_TOKEN: ready.current.token ?? '',
          E2E_KEEP: args.keep ? '1' : '0',
          E2E_KEPT_PREFIXES: kept.join(','),
          E2E_ACCEPTANCE: args.acceptance ? '1' : '0',
          E2E_METRICS_FILE: metricsFile,
          ...buildJourneyEnv(settings),
        },
        onStart: (pid) => {
          state.running = pid;
        },
      });

      state.running = null;

      if (exitCode !== 0 && !state.interrupted) {
        const tail = await deps.readImpdLogTail(ready.current);

        deps.log(`== impd log tail\n${tail}`);
      }

      return exitCode;
    };

    const result = await runSuites({
      names: args.suites,
      prefixOf: (name) =>
        SUITES.find((suite) => suite.name === name)?.prefix ?? `${PREFIX}${name}-`,
      journeysOf: (name) => {
        const suite = SUITES.find((candidate) => candidate.name === name);

        return suite === undefined ? [name] : listJourneys(suite);
      },
      keep: args.keep,
      runJourney: runJourneyProcess,
      checkJourney: (suite, journey) =>
        checkNoBootFallbacks({
          deps,
          name: suite,
          since: startedAt.get(journey) ?? new Date(deps.now()),
          target: ready.current,
        }),
      reset: (prefixes) => deps.resetSuites(prefixes, ready.current),
      settingsOf: (name) => readSuiteSettings(name, ready.current),
      rebootOnto: (settings) => deps.rebootInstance(ready.current, settings, run.env),
      reboot: () => deps.rebootInstance(ready.current, {}, run.env),
      fixturesOf: (name) => SUITES.find((suite) => suite.name === name)?.fixtures ?? [],
      startFixture: (fixture) => deps.readHostBFixture(fixture, run).start(),
      resetFixture: (fixture) => deps.readHostBFixture(fixture, run).reset(),
      stopFixture: (fixture) => deps.readHostBFixture(fixture, run).stop(),

      recreate: async () => {
        ready.current = await deps.recreateInstance(run);
      },
      isInterrupted: () => state.interrupted,
      now: deps.now,
      onSuiteStart: (name) => {
        deps.log(`== [${String(getSuiteIndex(name))}] ${name}`);
      },
      onSuiteEnd: (suiteResult) => {
        const section: Section = {
          index: getSuiteIndex(suiteResult.name),
          name: suiteResult.name,
          verdict: suiteResult.passed ? 'PASS' : 'FAIL',
          durationMs: suiteResult.durationMs,
        };

        sections.push(section);
        deps.log(`== ${formatSection(section)}`);
      },
      log: deps.warn,
    });

    stoppedBecause = result.stoppedBecause;

    if (stoppedBecause !== null && stoppedBecause !== 'interrupted') {
      deps.warn(`== the run stopped: ${stoppedBecause}`);
    }

    const isUp = stoppedBecause === null || stoppedBecause === 'interrupted';

    if (!args.keep && isUp) {
      await deps.removeLeftovers(args.suites, ready.current, run.env);
    }
  }

  if (args.suites.includes('https')) {
    await deps.stopPebble();
  }

  deps.writeResults(sections, {
    resultsFile,
    metricsFile,
    ramBudgetMib: config.ramBudgetMib,
    idleTimeoutS: config.idleTimeoutS,
    now: () => new Date(deps.now()),
  });

  deps.log(`== results: ${resultsFile}`);
  deps.log('== summary');

  for (const section of sections) {
    deps.log(`   ${formatSection(section)}`);
  }

  const passed = hasRunPassed({
    passed: sections.map((section) => section.verdict === 'PASS'),
    stoppedBecause,
    interrupted: state.interrupted,
  });

  const verdict = passed ? '== PASS' : '== FAIL';

  deps.log(verdict);

  if (state.interrupted) {
    return 130;
  }

  return passed ? 0 : 1;
}

function formatReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTimed(
  deps: HarnessDeps,
  name: string,
  body: () => Promise<boolean>,
): Promise<Section> {
  deps.log(`== [0] ${name}`);

  const started = deps.now();
  let passed: boolean;

  try {
    passed = await body();
  } catch (error) {
    deps.warn(`    FAIL: ${formatReason(error)}`);

    passed = false;
  }

  const section: Section = {
    index: 0,
    name,
    verdict: passed ? 'PASS' : 'FAIL',
    durationMs: deps.now() - started,
  };

  deps.log(`== ${formatSection(section)}`);

  return section;
}

function formatSection(section: Section): string {
  return `[${String(section.index)}] ${section.name.padEnd(12)} ${section.verdict} ${(section.durationMs / 1000).toFixed(1).padStart(7)} s`;
}

interface FallbackCheck {
  readonly deps: HarnessDeps;
  readonly name: string;
  readonly since: Readonly<Date>;
  readonly target: DevInstance;
}

// chaos kills firecracker on purpose, so a restore there may fall back.
const FALLBACK_SUITES: ReadonlySet<string> = new Set(['chaos']);

async function checkNoBootFallbacks(check: Readonly<FallbackCheck>): Promise<boolean> {
  let log: string;

  try {
    log = await check.deps.readImpdLogSince(check.since, check.target);
  } catch (error) {
    check.deps.log(`== ${check.name}: no impd log to check for boot fallbacks: ${String(error)}`);

    return false;
  }

  const fallbacks = collectBootFallbacks(log);

  if (fallbacks.length === 0) {
    return true;
  }

  const isAllowed = FALLBACK_SUITES.has(check.name);
  const verdict = isAllowed ? 'fell back, as the suite may cause' : 'fell back to the kernel';

  check.deps.log(`== ${check.name}: a boot template ${verdict}\n${fallbacks.join('\n')}`);

  return isAllowed;
}

function getSuiteIndex(name: string): number {
  return SUITES.findIndex((suite) => suite.name === name) + 1;
}
