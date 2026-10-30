import { appendFileSync } from 'node:fs';
import { $ } from 'bun';
import { formatStepValues } from '../lib/format-step-values.ts';
import { getStepEnv } from '../lib/get-step-env.ts';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

// The digest comes from the registry, after the push, so the attestation names exactly what was
// pushed.
async function main(): Promise<void> {
  const image = getStepEnv(process.env, 'IMAGE');
  const builtTag = getStepEnv(process.env, 'BUILT_TAG');
  const pushTag = getStepEnv(process.env, 'PUSH_TAG');
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');
  const ref = `${image}:${pushTag}`;

  if (builtTag !== pushTag) {
    await $`docker tag ${`${image}:${builtTag}`} ${ref}`;
  }

  await $`docker push ${ref}`;

  const inspected =
    await $`docker buildx imagetools inspect ${ref} --format ${'{{.Manifest.Digest}}'}`.text();

  const digest = inspected.trim();

  if (!digestPattern.test(digest)) {
    console.log(`::error::the registry gave no valid digest for ${ref}: ${digest}`);

    process.exitCode = 1;

    return;
  }

  appendFileSync(outputs, formatStepValues({ digest }));
}

if (import.meta.main) {
  await main();
}
