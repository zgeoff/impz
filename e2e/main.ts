import { join } from 'node:path';
import { REPO_ROOT } from './lib/instance';
import { runE2E } from './lib/run-e2e';
import { wireHarnessDeps } from './lib/wire-harness-deps';

if (import.meta.main) {
  const exitCode = await runE2E({
    argv: Bun.argv.slice(2),
    env: process.env,
    bunPath: process.execPath,
    resultsDir: join(REPO_ROOT, '.cache', 'e2e'),
    deps: wireHarnessDeps(process.cwd()),
  });

  process.exit(exitCode);
}
