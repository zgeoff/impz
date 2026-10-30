import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { writeStepValues } from '../lib/write-step-values.ts';

// A version already on npm is skipped, so a republish is safe. npm's `latest` moves only to the
// newest release, as the image's does, and a republish of an older one goes out under `previous`.
async function main(): Promise<void> {
  const version = getStepEnv(process.env, 'VERSION');
  const isNewest = getStepEnv(process.env, 'IS_NEWEST') === 'true';
  const isTestingEnabled = getStepEnv(process.env, 'TESTING_ENABLED') === 'true';
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');
  const client = !(await probePublished('@impz/client', version));

  // an older tag has no packages/testing, so it plans the client alone
  const testing =
    isTestingEnabled &&
    existsSync(join(tree, 'packages', 'testing', 'package.json')) &&
    !(await probePublished('@impz/testing', version));

  writeStepValues(outputs, { client: String(client), testing: String(testing) });

  if (!client && !testing) {
    writeStepValues(outputs, { publish: 'false' });

    return;
  }

  writeStepValues(outputs, { dist_tag: isNewest ? 'latest' : 'previous', publish: 'true' });
}

async function probePublished(name: string, version: string): Promise<boolean> {
  const viewed = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();

  if (viewed.stdout.toString().trim() !== version) {
    return false;
  }

  console.error(`${name}@${version} is on npm already`);

  return true;
}

if (import.meta.main) {
  await main();
}
