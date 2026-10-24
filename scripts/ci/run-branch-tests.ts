import { join } from 'node:path';
import { runRelatedTests } from './run-related-tests.ts';

// The root bun test skips the dashboard through bunfig.toml, so a dashboard file's tests run from
// its package.
const dashboardPrefix = 'packages/dashboard/';

// bunfig.toml leaves a lane file out of every root bun test, even one named by its path, so a
// lane file runs in its lane's script and never here.
const lanePattern = /\.(?:host|headscale|pebble|docker|small-fs)\.test\.ts$/u;

export async function runBranchTests(paths: readonly string[], cwd: string): Promise<number> {
  const unitPaths = paths.filter((path) => !lanePattern.test(path));

  const dashboard = unitPaths
    .filter((path) => path.startsWith(dashboardPrefix))
    .map((path) => path.slice(dashboardPrefix.length));

  const root = unitPaths.filter((path) => !path.startsWith(dashboardPrefix));

  const rootExitCode = await runRelatedTests(root, cwd);
  const dashboardExitCode = await runRelatedTests(dashboard, join(cwd, dashboardPrefix));

  return rootExitCode === 0 ? dashboardExitCode : rootExitCode;
}

if (import.meta.main) {
  const exitCode = await runBranchTests(process.argv.slice(2), process.cwd());

  process.exit(exitCode);
}
