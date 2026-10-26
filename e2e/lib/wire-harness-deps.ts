import { mkdirSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { createImpClient } from '@impz/client';
import { readTextOrNull } from '../../scripts/lib/read-text-or-null.ts';
import type { HarnessEnv } from './config';
import { createMissingImages } from './fixtures';
import { startHeadscale, stopHeadscale } from './headscale';
import { listImageNames, readInfo, runImpWith } from './imp-cli';
import { removeImpsWithPrefix } from './imps';
import type { DevInstance } from './instance';
import {
  REPO_ROOT,
  buildInstance,
  checkHealthReady,
  readHostImage,
  readImpdLogSince,
  readImpdLogTail,
  readToken,
  runChecked,
  runCommand,
  runDevScript,
} from './instance';
import {
  buildHostBFixtureDeps,
  createHostBFixture,
  pickHostBZfsRoot,
  readMoveOptions,
  removeMoveLeftovers,
} from './move-hosts';
import { startPebble, stopPebble } from './pebble';
import { checkPrivileges } from './privileges';
import { removeDataDir } from './remove-data-dir';
import { resetBaseline } from './reset-baseline';
import { resolveDataWipe } from './resolve-data-wipe';
import type { HarnessDeps, HarnessRun } from './run-e2e';
import { runSuite, stopSuiteGroup } from './run-suite';
import type { FixtureImage } from './suites';
import { SUITES } from './suites';
import { readTailscaleE2EAuthKey } from './tailscale-key';
import { startTailscaleTailnet, stopTailscaleTailnet } from './tailscale-tailnet';
import { writeResults } from './write-results';

export function wireHarnessDeps(cwd: string): HarnessDeps {
  return {
    readHostImage,
    readTailscaleKey: readTailscaleE2EAuthKey,
    startHeadscale: () => startHeadscale({ runCommand, runChecked }),
    stopHeadscale: () => stopHeadscale({ runCommand, runChecked }),
    startTailscale: (key) => startTailscaleTailnet({ runCommand, runChecked }, key),
    stopTailscale: () => stopTailscaleTailnet({ runCommand, runChecked }),
    setUpInstance: async (run) => {
      const target = buildInstance(run.env, cwd);

      if (run.args.clean) {
        await resetInstance(target, run.env);
      } else if (!run.args.reuse) {
        await runDevScript('down', target, {}, run.env);
      }

      if (run.args.suites.includes('https')) {
        await startPebble();
      }

      return startInstance(target, run);
    },
    recreateInstance: async (run) => {
      const target = buildInstance(run.env, cwd);

      await resetInstance(target, run.env);

      return startInstance(target, run);
    },
    resetSuites,
    rebootInstance: (target, settings, env) => runDevScript('reboot', target, settings, env),
    runJourney: (request) =>
      runSuite({ argv: request.argv, cwd: REPO_ROOT, env: request.env, onStart: request.onStart }),
    stopJourney: stopSuiteGroup,
    readImpdLogTail: (target) => readImpdLogTail(40, target),
    readImpdLogSince,
    readHostBFixture,
    removeLeftovers,
    stopPebble,
    createDirectory: (path) => {
      mkdirSync(path, { recursive: true });
    },
    removeFile: (path) => {
      rmSync(path, { force: true });
    },
    writeResults,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    exit: (code) => {
      process.exit(code);
    },
    now: Date.now,
    log: (line) => {
      console.log(line);
    },
    warn: (line) => {
      console.error(line);
    },
  };
}

async function resetInstance(target: DevInstance, env: HarnessEnv): Promise<void> {
  const cli = target.containerCLI;

  const data = await resolveDataWipe(target.dataDir, env);

  // A reset takes the second host's data too, so no old migration outlives a
  // rebase that renumbered it. The second host runs only under docker, and a
  // podman run neither stops it nor wipes what it may still be using.
  const hostB =
    cli === 'docker'
      ? await resolveDataWipe(`${target.dataDir}-mv-b`, env, pickHostBZfsRoot(env))
      : null;

  const targets = [data, hostB].filter((wipe) => wipe !== null);
  const wiped = targets.map((wipe) => wipe.directory).join(' and ') || 'nothing';

  console.log(`    clean reset: tailnet logout, remove ${target.container}, wipe ${wiped}`);

  const container = await runCommand([cli, 'inspect', target.container]);

  if (container.exitCode === 0) {
    await runCommand([cli, 'exec', target.container, '/usr/local/lib/imp/tailscale-down.sh']);
  }

  await runDevScript('down', target, {}, env);

  if (cli === 'docker') {
    await runCommand(['docker', 'rm', '-f', `${target.container}-mv-b`]);
  }

  for (const wipe of targets) {
    await removeDataDir(wipe, env, cli);
  }
}

async function startInstance(base: DevInstance, run: Readonly<HarnessRun>): Promise<DevInstance> {
  await runDevScript('up', base, {}, run.env);
  await checkPrivileges(base, readTextOrNull);

  const token = await readToken(base);

  const target: DevInstance = { ...base, token };

  const info = await readInfo(target);

  if (info.ramBudgetMib !== run.config.ramBudgetMib) {
    throw new Error(
      `impd RAM budget is ${String(info.ramBudgetMib)} MiB, not ${String(run.config.ramBudgetMib)}: ` +
        'scripts/dev/dev.sh did not pass IMP_RAM_BUDGET_MIB, or --reuse kept an instance with its own',
    );
  }

  // Leftovers of an aborted or --keep run would skew RAM numbers.
  await resetSuites(
    SUITES.map((suite) => suite.prefix),
    target,
  );

  if (run.args.suites.includes('scale')) {
    checkScaleHeadroom(target, run);
  }

  const images = new Set<FixtureImage>(
    SUITES.filter((suite) => run.args.suites.includes(suite.name)).flatMap((suite) => suite.images),
  );

  await createMissingImages([...images], target);

  return target;
}

async function resetSuites(prefixes: readonly string[], target: DevInstance): Promise<void> {
  const client = createImpClient({ url: target.apiUrl, token: target.token ?? '' });

  await resetBaseline({ client, prefixes, dataDir: target.dataDir });
}

function checkScaleHeadroom(target: DevInstance, run: Readonly<HarnessRun>): void {
  const availableMib = readAvailableMib();
  const config = run.config;

  if (availableMib < config.ramBudgetMib + 2048) {
    throw new Error(
      `only ${String(availableMib)} MiB available; the scale suite needs the budget ` +
        `${String(config.ramBudgetMib)} MiB + 2048 MiB headroom`,
    );
  }

  const disk = statfsSync(target.dataDir);
  const freeMib = Math.floor((disk.bavail * disk.bsize) / 1_048_576);
  const neededMib = config.scaleCount * config.scaleMemoryMib;

  if (freeMib < neededMib) {
    throw new Error(
      `only ${String(freeMib)} MiB free on the data volume; the scale suite needs ` +
        `${String(neededMib)} MiB for ${String(config.scaleCount)} snapshots`,
    );
  }
}

function readAvailableMib(): number {
  const match = /^MemAvailable:\s+(?<kib>\d+) kB$/mu.exec(readFileSync('/proc/meminfo', 'utf8'));

  return Math.floor(Number(match?.groups?.['kib'] ?? 0) / 1024);
}

function readHostBFixture(fixture: string, run: Readonly<HarnessRun>) {
  for (const suite of SUITES) {
    const name = suite.fixtures?.find((candidate) => candidate === fixture);

    if (name !== undefined) {
      return createHostBFixture(
        readMoveOptions(name),
        suite.prefix,
        buildHostBFixtureDeps(run.args.keep, run.env),
      );
    }
  }

  throw new Error(`no suite runs the fixture ${fixture}`);
}

const PREFIX = 'e2e-';

async function removeLeftovers(
  suites: readonly string[],
  target: DevInstance,
  env: HarnessEnv,
): Promise<void> {
  console.log('== cleanup');

  if (suites.some((suite) => suite.startsWith('moves'))) {
    await removeMoveLeftovers(env);
  }

  const healthy = await checkHealthReady(target);

  if (!healthy) {
    console.error('    impd is not ready; imps and images left in place');

    return;
  }

  try {
    await removeImpsWithPrefix(PREFIX, target);

    const images = await listImageNames(target);

    for (const image of images) {
      if (image.startsWith(PREFIX)) {
        await runImpWith({ target }, 'image', 'rm', image);
      }
    }
  } catch (error) {
    // The results and summary still matter more than a tidy instance.
    const reason = error instanceof Error ? error.message : String(error);

    console.error(`    cleanup failed: ${reason}`);
  }
}
