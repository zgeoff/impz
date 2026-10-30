import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';
import { writeStepValues } from '../lib/write-step-values.ts';
import { resolveTreeScript } from './resolve-tree-script.ts';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

// Every tag up to v0.27.0 has an unpinned images/base and no check script.
const pinnedBasePattern = /^ARG DOCKER_CE_VERSION=/mu;

// An existing tag without this repository's attestation may not be ours, and attesting it now would
// vouch for what nobody checked (docs/runbooks/releasing.md). A 401, a 403 or a network error from
// the registry never reads as a missing tag.
async function main(): Promise<void> {
  const baseImage = getStepEnv(process.env, 'BASE_IMAGE');
  const pushTag = getStepEnv(process.env, 'PUSH_TAG');
  const repository = getStepEnv(process.env, 'GITHUB_REPOSITORY');
  const tree = getStepEnv(process.env, 'GITHUB_WORKSPACE');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');
  const ref = `${baseImage}:${pushTag}`;
  const dockerfile = readFileSync(join(tree, 'images', 'base', 'Dockerfile'), 'utf8');

  if (
    resolveTreeScript(tree, 'check-base-image.sh') === null ||
    !pinnedBasePattern.test(dockerfile)
  ) {
    console.log(`::notice::this tree predates the published imp-base, so ${ref} is not built`);

    writeStepValues(outputs, { action: 'skip' });

    return;
  }

  const inspected =
    await $`docker buildx imagetools inspect ${ref} --format ${'{{.Manifest.Digest}}'}`
      .nothrow()
      .quiet();

  if (inspected.exitCode !== 0) {
    const error = inspected.stderr.toString();

    if (!error.includes(`${ref}: not found`)) {
      process.stderr.write(`cannot tell whether ${ref} exists:\n${error}`);

      process.exitCode = 1;

      return;
    }

    writeStepValues(outputs, { action: 'push' });

    return;
  }

  const digest = inspected.stdout.toString().trim();

  if (!digestPattern.test(digest)) {
    console.log(`::error::${ref} exists, but the registry gave no valid digest: ${digest}`);

    process.exitCode = 1;

    return;
  }

  const verified =
    await $`gh attestation verify ${`oci://${baseImage}@${digest}`} --repo ${repository}`
      .nothrow()
      .quiet();

  if (verified.exitCode !== 0) {
    process.stderr.write(verified.stdout);
    process.stderr.write(verified.stderr);

    console.log(
      `::error::${ref} exists at ${digest} with no attestation from ${repository}; treat it as a possible compromise (docs/runbooks/releasing.md)`,
    );

    process.exitCode = 1;

    return;
  }

  console.log(
    `::notice::${ref} exists already at ${digest}, attested; a published imp-base never moves, so this run leaves it alone`,
  );

  writeStepValues(outputs, { action: 'skip' });
}

if (import.meta.main) {
  await main();
}
