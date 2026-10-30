import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { findTreeScript } from './find-tree-script.ts';
import { pickFormulaStep } from './pick-formula-step.ts';
import type { FormulaFacts } from './pick-formula-step.ts';

async function main(): Promise<void> {
  const tap = getStepEnv(process.env, 'TAP');
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const clone = join(tree, 'tap');

  const facts: FormulaFacts = {
    version: getStepEnv(process.env, 'VERSION'),
    generator: findTreeScript('build-formula.sh', (path) => existsSync(join(tree, path))),
    formula: null,
    hasChange: null,
  };

  for (;;) {
    const step = pickFormulaStep(facts);

    if (step.kind === 'generate') {
      // gh hands git the token as a credential helper, so it never lands in tap/.git/config
      await $`gh auth setup-git`;
      await $`gh repo clone ${tap} ${clone}`;

      mkdirSync(join(clone, 'Formula'), { recursive: true });

      facts.formula = await $`${join(tree, step.generator)} ${facts.version} dist/SHA256SUMS`
        .cwd(tree)
        .text();

      continue;
    }

    if (step.kind === 'stage') {
      writeFileSync(join(clone, 'Formula', 'impz.rb'), step.formula);

      await $`git -C ${clone} config user.name ${'github-actions[bot]'}`;
      await $`git -C ${clone} config user.email ${'41898282+github-actions[bot]@users.noreply.github.com'}`;
      await $`git -C ${clone} add Formula/impz.rb`;

      const staged = await $`git -C ${clone} diff --cached --quiet`.nothrow();

      facts.hasChange = staged.exitCode !== 0;
      continue;
    }

    if (step.kind === 'fail') {
      console.error(step.message);

      process.exitCode = 1;

      return;
    }

    if (step.kind === 'finish') {
      console.log(step.message);

      return;
    }

    if (step.kind === 'publish') {
      await $`git -C ${clone} commit -m ${step.subject}`;

      // rebases onto whatever else landed in the tap meanwhile, such as another project's formula
      await $`git -C ${clone} pull --rebase`;
      await $`git -C ${clone} push`;

      return;
    }

    // a release tool cannot import ts-pattern, so this assignment fails the type check instead
    // when a new step kind has no branch above
    const unhandled: never = step;

    throw new Error(`no branch runs the formula step ${JSON.stringify(unhandled)}`);
  }
}

if (import.meta.main) {
  await main();
}
