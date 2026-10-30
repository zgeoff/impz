import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { findTreeScript } from './find-tree-script.ts';

const classPattern = /^class (?<name>[A-Za-z0-9]+) < Formula$/mu;

// The tap offers only impz. Homebrew loads a formula only from the file its class names, and a tag
// from before the rename to impz generates class Imp, so its formula stays out of the tap.
async function main(): Promise<void> {
  const tap = getStepEnv(process.env, 'TAP');
  const version = getStepEnv(process.env, 'VERSION');
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const clone = join(tree, 'tap');
  const generator = findTreeScript('build-formula.sh', (path) => existsSync(join(tree, path)));

  if (generator === null) {
    console.error('the checked-out tree has no build-formula.sh');

    process.exitCode = 1;

    return;
  }

  // gh hands git the token as a credential helper, so it never lands in tap/.git/config
  await $`gh auth setup-git`;
  await $`gh repo clone ${tap} ${clone}`;

  mkdirSync(join(clone, 'Formula'), { recursive: true });

  const formula = await $`${join(tree, generator)} ${version} dist/SHA256SUMS`.cwd(tree).text();

  const name = classPattern.exec(formula)?.groups?.['name'];

  if (name === undefined) {
    console.error(`${generator} printed no formula class`);

    process.exitCode = 1;

    return;
  }

  if (name !== 'Impz') {
    console.log(
      `${generator} printed class ${name}; the tap offers only impz, so the formula stays`,
    );

    return;
  }

  writeFileSync(join(clone, 'Formula', 'impz.rb'), formula);

  await $`git -C ${clone} config user.name ${'github-actions[bot]'}`;
  await $`git -C ${clone} config user.email ${'41898282+github-actions[bot]@users.noreply.github.com'}`;
  await $`git -C ${clone} add Formula/impz.rb`;

  const staged = await $`git -C ${clone} diff --cached --quiet`.nothrow();

  if (staged.exitCode === 0) {
    console.log(`the formula is at ${version} already`);

    return;
  }

  await $`git -C ${clone} commit -m ${`impz ${version}`}`;

  // rebases onto whatever else landed in the tap meanwhile, such as another project's formula
  await $`git -C ${clone} pull --rebase`;
  await $`git -C ${clone} push`;
}

if (import.meta.main) {
  await main();
}
