import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, readImpEnv } from '../lib/imp-cli';
import { REPO_ROOT, runChecked } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('dashboard'), stack, client };
}

test('it logs in, creates, opens a console, sleeps and destroys an imp, and logs out in a browser against impd', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}ui`;
  const dashboardDir = join(REPO_ROOT, 'packages', 'dashboard');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  // dev.sh serves packages/dashboard/dist, which impd reads per request.
  await runChecked(['bun', 'run', '--cwd', dashboardDir, 'build']);
  await runChecked(['bun', 'run', '--cwd', dashboardDir, 'e2e:install']);

  const impEnv = await readImpEnv();

  const startedAt = performance.now();

  const subprocess = Bun.spawn(['bun', 'run', 'e2e'], {
    cwd: dashboardDir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...impEnv,
      E2E_IMP_PREFIX: ctx.prefix,
      E2E_IMP_NAME: name,
      E2E_IMP_IMAGE: resolveImageName('e2e-tiny'),
    },
  });

  ctx.stack.defer(() => {
    subprocess.kill();
  });

  const exitCode = await subprocess.exited;

  writeMetric('dashboardBrowserMs', Math.round(performance.now() - startedAt));

  expect(exitCode).toBe(0);
});
