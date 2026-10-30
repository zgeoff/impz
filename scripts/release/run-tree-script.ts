import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { findTreeScript } from './find-tree-script.ts';

async function main(): Promise<void> {
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const argv = process.argv.slice(2);

  // the wrapper takes one name before --, so a flag before it is refused rather than forwarded
  const parsed = parseArgs({ args: argv, strict: false, allowPositionals: true, tokens: true });
  const terminator = parsed.tokens.find((token) => token.kind === 'option-terminator');
  const ownCount = terminator === undefined ? argv.length : terminator.index;
  const names = argv.slice(0, ownCount);
  const args = argv.slice(ownCount + 1);
  const [name] = names;

  if (names.length !== 1 || name === undefined) {
    console.error('usage: run-tree-script.ts <script name> [-- args...]');

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
