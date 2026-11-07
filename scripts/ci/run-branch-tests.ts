import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { readOptionalText } from '../read-optional-text.ts';
import type { WorkerCountSources } from '../read-worker-count.ts';
import type { RelatedTestSources } from '../run-related-tests.ts';
import { runRelatedTests } from '../run-related-tests.ts';

// A dashboard file's tests need the DOM that the dashboard package's preload registers, so they run
// from that package. rig related runs every other test from the root, and its own ignore patterns
// replace the bunfig.toml list that leaves the dashboard out of a root bun test.
const dashboardPrefix = 'packages/dashboard/';

export async function runBranchTests(
  paths: readonly string[],
  sources: Readonly<RelatedTestSources>,
  workerSources: Readonly<WorkerCountSources>,
): Promise<number> {
  const dashboard = paths
    .filter((path) => path.startsWith(dashboardPrefix))
    .map((path) => path.slice(dashboardPrefix.length));

  const root = paths.filter((path) => !path.startsWith(dashboardPrefix));

  const rootExitCode = await Bun.spawn(['rig', 'related', ...root], {
    cwd: sources.cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited;

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
