import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { formatStepValues } from '../lib/format-step-values.ts';
import { getStepEnv } from '../lib/get-step-env.ts';
import { findTreeScript } from './find-tree-script.ts';
import { pickBaseImageStep } from './pick-base-image-step.ts';
import type { BaseImageFacts, CommandResult } from './pick-base-image-step.ts';

async function main(): Promise<void> {
  const baseImage = getStepEnv(process.env, 'BASE_IMAGE');
  const pushTag = getStepEnv(process.env, 'PUSH_TAG');
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');
  const checkScript = findTreeScript('check-base-image.sh', (path) => existsSync(join(tree, path)));

  const facts: BaseImageFacts = {
    ref: `${baseImage}:${pushTag}`,
    repository: getStepEnv(process.env, 'GITHUB_REPOSITORY'),
    hasCheckScript: checkScript !== null,
    dockerfile: readFileSync(join(tree, 'images', 'base', 'Dockerfile'), 'utf8'),
    inspected: null,
    verified: null,
  };

  for (;;) {
    const step = pickBaseImageStep(facts);

    if (step.kind === 'inspect') {
      facts.inspected = await runCommand(
        $`docker buildx imagetools inspect ${facts.ref} --format ${'{{.Manifest.Digest}}'}`,
      );

      continue;
    }

    if (step.kind === 'verify') {
      facts.verified = await runCommand(
        $`gh attestation verify ${`oci://${baseImage}@${step.digest}`} --repo ${facts.repository}`,
      );

      continue;
    }

    if (step.kind === 'finish') {
      if (step.notice !== null) {
        console.log(`::notice::${step.notice}`);
      }

      appendFileSync(outputs, formatStepValues({ action: step.action }));

      return;
    }

    if (step.kind === 'fail') {
      process.stderr.write(step.stderr);

      if (step.error !== null) {
        console.log(`::error::${step.error}`);
      }

      process.exitCode = 1;

      return;
    }

    // a release tool cannot import ts-pattern, so this assignment fails the type check instead
    // when a new step kind has no branch above
    const unhandled: never = step;

    throw new Error(`no branch runs the base image step ${JSON.stringify(unhandled)}`);
  }
}

async function runCommand(command: ReturnType<typeof $>): Promise<CommandResult> {
  const result = await command.nothrow().quiet();

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

if (import.meta.main) {
  await main();
}
