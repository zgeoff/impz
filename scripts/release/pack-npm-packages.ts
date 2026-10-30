import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { writeStepValues } from '../lib/write-step-values.ts';
import { findTreeScript } from './find-tree-script.ts';

// @impz/testing's check installs the client tarball of the same release, so the client is packed
// even when only the testing package goes out.
async function main(): Promise<void> {
  const isClientPlanned = getStepEnv(process.env, 'CLIENT') === 'true';
  const isTestingPlanned = getStepEnv(process.env, 'TESTING') === 'true';
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');
  const tarballs = join(tree, 'npm-tarball');

  const runTreeScript = (name: string, args: readonly string[]) => {
    const script = findTreeScript(name, (path) => existsSync(join(tree, path)));

    if (script === null) {
      throw new Error(`the checked-out tree has no ${name}`);
    }

    return $`${join(tree, script)} ${args}`.cwd(tree);
  };

  const packedClient = await runTreeScript('pack-client.sh', []).text();

  const client = packedClient.trim();

  await runTreeScript('check-client-package.sh', [client]);

  mkdirSync(tarballs, { recursive: true });

  if (isClientPlanned) {
    copyFileSync(client, join(tarballs, basename(client)));
    writeStepValues(outputs, { client_tarball: basename(client) });
  }

  if (isTestingPlanned) {
    const packedTesting = await runTreeScript('pack-testing.sh', []).text();

    const testing = packedTesting.trim();

    await runTreeScript('check-testing-package.sh', [testing, client]);

    copyFileSync(testing, join(tarballs, basename(testing)));
    writeStepValues(outputs, { testing_tarball: basename(testing) });
  }
}

if (import.meta.main) {
  await main();
}
