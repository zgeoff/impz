import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { readOptionalText } from '../read-optional-text.ts';
import type { WorkerCountSources } from '../read-worker-count.ts';
import type { RelatedTestSources } from '../run-related-tests.ts';
import { runRelatedTests } from '../run-related-tests.ts';

// The root bun test skips the dashboard through bunfig.toml, so a dashboard file's tests run from
// its package.
const dashboardPrefix = 'packages/dashboard/';

// bunfig.toml leaves a lane file out of every root bun test, even one named by its path, so a
// lane file runs in its lane's script and never here.
const lanePattern = /\.(?:host|headscale|pebble|docker|small-fs)\.test\.ts$/u;

export async function runBranchTests(
  paths: readonly string[],
  sources: Readonly<RelatedTestSources>,
  workerSources: Readonly<WorkerCountSources>,
): Promise<number> {
  const unitPaths = paths.filter((path) => !lanePattern.test(path));

  const dashboard = unitPaths
    .filter((path) => path.startsWith(dashboardPrefix))
    .map((path) => path.slice(dashboardPrefix.length));

  const root = unitPaths.filter((path) => !path.startsWith(dashboardPrefix));

  const rootExitCode = await runRelatedTests(root, sources, workerSources);

  const dashboardExitCode = await runRelatedTests(
    dashboard,
    { ...sources, cwd: join(sources.cwd, dashboardPrefix) },
    workerSources,
  );

  return rootExitCode === 0 ? dashboardExitCode : rootExitCode;
}

if (import.meta.main) {
  const exitCode = await runBranchTests(
    process.argv.slice(2),
    { cwd: process.cwd(), readConfigText: readOptionalFileText, probeFile: existsSync },
    {
      env: process.env,
      cores: availableParallelism(),
      totalMemory: totalmem(),
      procRoot: '/proc',
      cgroupRoot: '/sys/fs/cgroup',
      readText: readOptionalText,
    },
  );

  process.exit(exitCode);
}

function readOptionalFileText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
