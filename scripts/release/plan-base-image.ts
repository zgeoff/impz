import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { match } from 'ts-pattern';
import { getStepEnv } from '../lib/get-step-env.ts';
import { writeStepValues } from '../lib/write-step-values.ts';
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

    match(step)
      .with({ kind: 'finish' }, (finish) => {
        if (finish.notice !== null) {
          console.log(`::notice::${finish.notice}`);
        }

        writeStepValues(outputs, { action: finish.action });
      })
      .with({ kind: 'fail' }, (failure) => {
        process.stderr.write(failure.stderr);

        if (failure.error !== null) {
          console.log(`::error::${failure.error}`);
        }

        process.exitCode = 1;
      })
      .exhaustive();

    return;
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
