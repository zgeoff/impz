interface SuiteResult {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
}

export interface RunSuitesDeps {
  readonly names: readonly string[];
  readonly prefixOf: (name: string) => string;

  readonly journeysOf: (name: string) => readonly string[];

  readonly keep: boolean;

  readonly runJourney: (journey: string, kept: readonly string[]) => Promise<number>;

  readonly checkJourney: (suite: string, journey: string) => Promise<boolean>;
  readonly reset: (prefixes: readonly string[]) => Promise<void>;

  readonly settingsOf: (name: string) => Readonly<Record<string, string>> | null;

  readonly rebootOnto: (settings: Readonly<Record<string, string>>) => Promise<void>;

  readonly reboot: () => Promise<void>;

  readonly recreate: () => Promise<void>;

  readonly fixturesOf?: (name: string) => readonly string[];

  readonly startFixture: (fixture: string) => Promise<void>;
  readonly resetFixture: (fixture: string) => Promise<void>;
  readonly stopFixture: (fixture: string) => Promise<void>;
  readonly isInterrupted: () => boolean;
  readonly now: () => number;
  readonly onSuiteStart: (name: string) => void;
  readonly onSuiteEnd: (result: Readonly<SuiteResult>) => void;
  readonly log: (line: string) => void;
}

export interface RunSuitesResult {
  readonly results: readonly SuiteResult[];

  readonly stoppedBecause: string | null;
}

export async function runSuites(deps: Readonly<RunSuitesDeps>): Promise<RunSuitesResult> {
  const results: SuiteResult[] = [];
  let carried: readonly string[] = [];

  // A kept scale leaves the instance on its settings, so restart re-adopts the
  // fleet running as scale left it.
  let isCarriedOffRunSettings = false;

  for (const name of deps.names) {
    if (deps.isInterrupted()) {
      if (isCarriedOffRunSettings) {
        await resetRunSettings(deps, 'scale');
      }

      return { results, stoppedBecause: 'interrupted' };
    }

    deps.onSuiteStart(name);

    const started = deps.now();
    const prefix = deps.prefixOf(name);
    const isKeptForRestart = name === 'scale' && deps.names.includes('restart');
    const prefixes = [prefix, ...carried];
    let isKept = false;
    let isPassed = true;
    let stoppedBecause: string | null = null;
    const settings = readSettings(deps, name);
    const ownSettings = settings ?? null;
    let isOffRunSettings: boolean = isCarriedOffRunSettings;
    let isOnSettings = false;

    if (settings === undefined) {
      isPassed = false;
    }

    const fixtures = deps.fixturesOf?.(name) ?? [];
    let isFixtureStarted = false;

    for (const journey of settings === undefined ? [] : deps.journeysOf(name)) {
      if (deps.isInterrupted()) {
        isPassed = false;
        break;
      }

      if (!isFixtureStarted && fixtures.length > 0) {
        isFixtureStarted = true;

        const isStarted = await startFixtures(deps, name, fixtures);

        if (!isStarted) {
          isPassed = false;
          break;
        }
      }

      if (ownSettings !== null && !isOnSettings) {
        isOffRunSettings = true;

        isOnSettings = await runRebootOnto(deps, name, ownSettings);

        if (!isOnSettings || deps.isInterrupted()) {
          isPassed = false;
          break;
        }
      }

      const verdict = await runChecked(deps, name, journey, carried);

      isKept = isKeptForRestart && verdict.isPassed && verdict.isClean;

      const isRestored = await resetAfterJourney(deps, journey, verdict.isPassed, {
        prefixes,
        isSkipped: deps.keep || isKept,
        reboot: ownSettings === null ? deps.reboot : () => deps.rebootOnto(ownSettings),
      });

      if (!isRestored && !deps.isInterrupted()) {
        try {
          await deps.recreate();

          isOnSettings = false;
          isOffRunSettings = false;
        } catch (error) {
          stoppedBecause = `the instance could not be made anew after ${journey}: ${readReason(error)}`;
        }
      }

      const fixtureReset =
        deps.keep || deps.isInterrupted() ? 'reset' : await resetFixtures(deps, journey, fixtures);

      // A fixture made anew may reboot the instance off the suite's settings, as
      // host B's stop takes A off its network, so the next journey reboots onto
      // them first.
      if (fixtureReset !== 'reset') {
        isOnSettings = false;
      }

      isPassed &&= verdict.isPassed && verdict.isClean && isRestored && fixtureReset === 'reset';

      if (stoppedBecause !== null || fixtureReset === 'lost') {
        break;
      }
    }

    carried = isKept ? [prefix] : [];
    isCarriedOffRunSettings = isKept && isOffRunSettings && stoppedBecause === null;

    if (isOffRunSettings && stoppedBecause === null && !isCarriedOffRunSettings) {
      const restored = await resetRunSettings(deps, name);

      isPassed &&= restored.isRestored;
      stoppedBecause = restored.stoppedBecause;
    }

    if (isFixtureStarted) {
      const isStopped = await stopFixtures(deps, name, fixtures);

      isPassed &&= isStopped;
    }

    const result = { name, passed: isPassed, durationMs: deps.now() - started };

    results.push(result);
    deps.onSuiteEnd(result);

    if (stoppedBecause !== null) {
      return { results, stoppedBecause };
    }
  }

  return { results, stoppedBecause: deps.isInterrupted() ? 'interrupted' : null };
}

interface SettingsRestore {
  readonly isRestored: boolean;
  readonly stoppedBecause: string | null;
}

async function resetRunSettings(
  deps: Readonly<RunSuitesDeps>,
  name: string,
): Promise<SettingsRestore> {
  try {
    await deps.reboot();

    return { isRestored: true, stoppedBecause: null };
  } catch (error) {
    deps.log(
      `    the instance could not reboot off the ${name} suite's settings: ${readReason(error)}`,
    );
  }

  if (deps.isInterrupted()) {
    return { isRestored: false, stoppedBecause: null };
  }

  try {
    await deps.recreate();

    return { isRestored: false, stoppedBecause: null };
  } catch (error) {
    return {
      isRestored: false,
      stoppedBecause: `the instance could not be made anew after the ${name} suite: ${readReason(error)}`,
    };
  }
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSettings(
  deps: Readonly<RunSuitesDeps>,
  name: string,
): Readonly<Record<string, string>> | null | undefined {
  try {
    return deps.settingsOf(name);
  } catch (error) {
    deps.log(`    the ${name} suite's settings could not be read: ${readReason(error)}`);

    return undefined;
  }
}

async function startFixtures(
  deps: Readonly<RunSuitesDeps>,
  name: string,
  fixtures: readonly string[],
): Promise<boolean> {
  for (const fixture of fixtures) {
    try {
      await deps.startFixture(fixture);
    } catch (error) {
      deps.log(`    the ${name} suite's ${fixture} could not start: ${readReason(error)}`);

      return false;
    }
  }

  return true;
}

async function runRebootOnto(
  deps: Readonly<RunSuitesDeps>,
  name: string,
  settings: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    await deps.rebootOnto(settings);

    return true;
  } catch (error) {
    deps.log(
      `    the instance could not reboot onto the ${name} suite's settings: ${readReason(error)}`,
    );

    return false;
  }
}

interface JourneyVerdict {
  readonly isPassed: boolean;
  readonly isClean: boolean;
}

async function runChecked(
  deps: Readonly<RunSuitesDeps>,
  suite: string,
  journey: string,
  kept: readonly string[],
): Promise<JourneyVerdict> {
  let isPassed = false;

  try {
    const exitCode = await deps.runJourney(journey, kept);

    isPassed = exitCode === 0;
  } catch (error) {
    deps.log(`    the ${journey} journey could not run: ${readReason(error)}`);
  }

  try {
    const isClean = await deps.checkJourney(suite, journey);

    return { isPassed, isClean };
  } catch (error) {
    deps.log(`    the ${journey} journey's checks failed: ${readReason(error)}`);

    return { isPassed, isClean: false };
  }
}

interface RestoreOptions {
  readonly prefixes: readonly string[];

  readonly isSkipped: boolean;

  readonly reboot: () => Promise<void>;
}

async function resetAfterJourney(
  deps: Readonly<RunSuitesDeps>,
  journey: string,
  isPassed: boolean,
  options: Readonly<RestoreOptions>,
): Promise<boolean> {
  if (options.isSkipped) {
    return true;
  }

  try {
    if (!isPassed && !deps.isInterrupted()) {
      await options.reboot();
    }

    await deps.reset(options.prefixes);

    return true;
  } catch (error) {
    deps.log(`    the ${journey} journey left the baseline dirty: ${readReason(error)}`);

    return false;
  }
}

async function resetFixtures(
  deps: Readonly<RunSuitesDeps>,
  journey: string,
  fixtures: readonly string[],
): Promise<'reset' | 'anew' | 'lost'> {
  let outcome: 'reset' | 'anew' = 'reset';

  for (const fixture of fixtures) {
    try {
      await deps.resetFixture(fixture);

      continue;
    } catch (error) {
      deps.log(`    the ${journey} journey left ${fixture} dirty: ${readReason(error)}`);
    }

    try {
      await deps.stopFixture(fixture);
      await deps.startFixture(fixture);

      outcome = 'anew';
    } catch (error) {
      deps.log(`    ${fixture} could not be made anew after ${journey}: ${readReason(error)}`);

      return 'lost';
    }
  }

  return outcome;
}

async function stopFixtures(
  deps: Readonly<RunSuitesDeps>,
  name: string,
  fixtures: readonly string[],
): Promise<boolean> {
  let isStopped = true;

  for (const fixture of fixtures.toReversed()) {
    try {
      await deps.stopFixture(fixture);
    } catch (error) {
      deps.log(`    the ${name} suite's ${fixture} could not stop: ${readReason(error)}`);

      isStopped = false;
    }
  }

  return isStopped;
}

export interface RunVerdictInput {
  readonly passed: readonly boolean[];
  readonly stoppedBecause: string | null;
  readonly interrupted: boolean;
}

export function hasRunPassed(input: Readonly<RunVerdictInput>): boolean {
  return input.passed.every(Boolean) && input.stoppedBecause === null && !input.interrupted;
}
