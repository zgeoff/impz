import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { findTreeScript } from './find-tree-script.ts';

async function main(): Promise<void> {
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const [name, ...args] = process.argv.slice(2);

  if (name === undefined) {
    console.error('usage: run-tree-script.ts <script name> [args...]');

    process.exitCode = 2;

    return;
  }

  const script = findTreeScript(name, (path) => existsSync(join(tree, path)));

  if (script === null) {
    console.error(`the checked-out tree has no ${name} in scripts/release, scripts or host`);

    process.exitCode = 1;

    return;
  }

  const result = await $`${join(tree, script)} ${args}`.cwd(tree).nothrow();

  process.exitCode = result.exitCode;
}

if (import.meta.main) {
  await main();
}
