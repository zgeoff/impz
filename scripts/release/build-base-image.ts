import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';

// Loads into the runner's docker, so the image checked is the image pushed. The revision is the
// commit checked out: on a republish, the workflow's commit is main's head, not the tag's.
async function main(): Promise<void> {
  const baseImage = getStepEnv(process.env, 'BASE_IMAGE');
  const pushTag = getStepEnv(process.env, 'PUSH_TAG');
  const version = getStepEnv(process.env, 'VERSION');
  const source = getStepEnv(process.env, 'SOURCE');
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');

  const head = await $`git -C ${tree} rev-parse HEAD`.text();

  const labels = [
    `org.opencontainers.image.source=${source}`,
    `org.opencontainers.image.revision=${head.trim()}`,
    `org.opencontainers.image.version=${version}`,
    'org.opencontainers.image.description=imp base image: Ubuntu 24.04 with the Docker engine',
  ].flatMap((label) => ['--label', label]);

  await $`docker buildx build images/base --platform linux/amd64 --load --tag ${`${baseImage}:${pushTag}`} ${labels}`.cwd(
    tree,
  );
}

if (import.meta.main) {
  await main();
}
