import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStepEnv } from '../lib/get-step-env.ts';
import { writeStepValues } from '../lib/write-step-values.ts';

const tagPattern = /^v(?<version>\d+\.\d+\.\d+)$/u;

// A release's version is its tag without the v, and the image check holds package.json to it. A
// dry run, with no tag, takes package.json's version and pushes under a tag of its own.
function main(): void {
  const tag = getStepEnv(process.env, 'TAG');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');

  if (tag === '') {
    const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
    const sha = getStepEnv(process.env, 'GITHUB_SHA');
    const manifest: unknown = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));

    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('version' in manifest) ||
      typeof manifest.version !== 'string'
    ) {
      console.error('package.json holds no version');

      process.exitCode = 1;

      return;
    }

    writeStepValues(outputs, { version: manifest.version, push_tag: `dryrun-${sha.slice(0, 12)}` });

    return;
  }

  const version = tagPattern.exec(tag)?.groups?.['version'];

  if (version === undefined) {
    console.error(`tag ${tag} is not vX.Y.Z`);

    process.exitCode = 1;

    return;
  }

  writeStepValues(outputs, { version, push_tag: version });
}

if (import.meta.main) {
  main();
}
