import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { pickCLIBinaryStep } from './pick-cli-binary-step.ts';
import type { CLIBinaryFacts } from './pick-cli-binary-step.ts';

async function main(): Promise<void> {
  const dist = join(getStepEnv(process.env, 'GITHUB_WORKSPACE'), 'dist');

  const facts: CLIBinaryFacts = {
    target: getStepEnv(process.env, 'TARGET'),
    version: getStepEnv(process.env, 'VERSION'),
    distFiles: readdirSync(dist),
    sums: readFileSync(join(dist, 'SHA256SUMS'), 'utf8'),
    binarySum: null,
    reported: null,
  };

  for (;;) {
    const step = pickCLIBinaryStep(facts);

    if (step.kind === 'hash') {
      const binary = readFileSync(join(dist, step.name));

      facts.binarySum = new Bun.CryptoHasher('sha256').update(binary).digest('hex');

      continue;
    }

    if (step.kind === 'ask-version') {
      chmodSync(join(dist, step.name), 0o755);

      facts.reported = await $`${join(dist, step.name)} --version`.text();

      continue;
    }

    if (step.kind === 'fail') {
      console.error(step.message);

      process.exitCode = 1;

      return;
    }

    if (step.kind === 'check-completions') {
      const binary = join(dist, step.name);

      await Promise.all(step.shells.map((shell) => $`${binary} completion ${shell}`.quiet()));

      console.log(step.message);

      return;
    }

    // a release tool cannot import ts-pattern, so this assignment fails the type check instead
    // when a new step kind has no branch above
    const unhandled: never = step;

    throw new Error(`no branch runs the binary check step ${JSON.stringify(unhandled)}`);
  }
}

if (import.meta.main) {
  await main();
}
