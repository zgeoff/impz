import { appendFileSync } from 'node:fs';
import { $ } from 'bun';
import { formatStepValues } from '../lib/format-step-values.ts';
import { getStepEnv } from '../lib/get-step-env.ts';

// The lookup and the move run in one step, under the latest-tag group's lock across release runs.
// The newest release only moves forward, so a run that holds the lock after a newer one finds
// itself not the newest and leaves `latest`, in whatever order GitHub starts the waiting jobs.
async function main(): Promise<void> {
  const tag = getStepEnv(process.env, 'TAG');
  const version = getStepEnv(process.env, 'VERSION');
  const image = getStepEnv(process.env, 'IMAGE');
  const repository = getStepEnv(process.env, 'GITHUB_REPOSITORY');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');

  const viewed = await $`gh release view --repo ${repository} --json tagName --jq .tagName`.text();

  const newest = viewed.trim();

  appendFileSync(outputs, formatStepValues({ newest_tag: newest }));

  if (tag !== newest) {
    appendFileSync(outputs, formatStepValues({ is_newest: 'false' }));

    console.log(`${tag} is not the newest release (${newest}); latest stays`);

    return;
  }

  appendFileSync(outputs, formatStepValues({ is_newest: 'true' }));

  await $`docker buildx imagetools create -t ${`${image}:latest`} ${`${image}:${version}`}`;
}

if (import.meta.main) {
  await main();
}
