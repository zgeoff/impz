import { $ } from 'bun';

const generatedPaths = [
  'agent/internal/proto',
  'packages/agent-protocol/src/gen',
  'docs/reference',
];

async function main(): Promise<void> {
  await $`bun run gen:proto`;

  const status = await $`git status --porcelain -- ${generatedPaths}`.text();

  const changed = status.trimEnd();

  if (changed !== '') {
    console.log(changed);
    console.log('::error::the generated protocol code differs from proto/; run bun run gen:proto');

    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
