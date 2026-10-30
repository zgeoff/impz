import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { writeStepValues } from '../lib/write-step-values.ts';

// /mnt is a runner's larger temp disk, when its image has one. Each suffix argument names a sibling
// folder to make beside the data dir, such as the one a second impd keeps its data in.
async function main(): Promise<void> {
  const [variable, mntDir, fallbackDir, ...suffixes] = process.argv.slice(2);
  const githubEnv = getStepEnv(process.env, 'GITHUB_ENV');

  if (variable === undefined || mntDir === undefined || fallbackDir === undefined) {
    console.error('usage: pick-data-dir.ts <env name> <dir on /mnt> <fallback dir> [suffix...]');

    process.exitCode = 2;

    return;
  }

  await $`df -h / /mnt`.nothrow();

  const mountpoint = await $`mountpoint -q /mnt`.nothrow();

  const dataDir = mountpoint.exitCode === 0 ? mntDir : fallbackDir;
  const dirs = [dataDir, ...suffixes.map((suffix) => `${dataDir}${suffix}`)];
  const owner = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;

  await $`sudo mkdir -p ${dirs}`;
  await $`sudo chown ${owner} ${dirs}`;

  writeStepValues(githubEnv, { [variable]: dataDir });
}

if (import.meta.main) {
  await main();
}
