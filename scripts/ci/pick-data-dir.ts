import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { $ } from 'bun';
import { formatStepValues } from '../lib/format-step-values.ts';
import { getStepEnv } from '../lib/get-step-env.ts';

const USAGE =
  'usage: pick-data-dir.ts --env <name> --mnt <dir on /mnt> --fallback <dir> [--sibling=<suffix>...]';

// /mnt is a runner's larger temp disk, when its image has one. Each sibling suffix names a folder
// to make beside the data dir, such as the one a second impd keeps its data in.
async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      env: { type: 'string' },
      mnt: { type: 'string' },
      fallback: { type: 'string' },
      sibling: { type: 'string', multiple: true, default: [] },
    },
  });

  const values = parsed.values;
  const githubEnv = getStepEnv(process.env, 'GITHUB_ENV');

  if (values.env === undefined || values.mnt === undefined || values.fallback === undefined) {
    console.error(USAGE);

    process.exitCode = 2;

    return;
  }

  await $`df -h / /mnt`.nothrow();

  const mountpoint = await $`mountpoint -q /mnt`.nothrow();

  const dataDir = mountpoint.exitCode === 0 ? values.mnt : values.fallback;
  const dirs = [dataDir, ...values.sibling.map((suffix) => `${dataDir}${suffix}`)];
  const owner = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;

  await $`sudo mkdir -p ${dirs}`;
  await $`sudo chown ${owner} ${dirs}`;

  appendFileSync(githubEnv, formatStepValues({ [values.env]: dataDir }));
}

if (import.meta.main) {
  await main();
}
