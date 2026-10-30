import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';

const benchDir = join('.cache', 'bench');

async function main(): Promise<void> {
  const stepSummary = getStepEnv(process.env, 'GITHUB_STEP_SUMMARY');

  mkdirSync(benchDir, { recursive: true });

  await $`scripts/dev/dev.sh up`;

  const printed = await $`scripts/dev/dev.sh token`.text();

  const measured = await $`${process.execPath} scripts/bench/measure-touched-pages.ts`
    .env({ ...process.env, IMP_URL: 'http://localhost:7070', IMP_TOKEN: printed.trim() })
    .text();

  process.stdout.write(measured);

  writeFileSync(join(benchDir, 'touched-pages.json'), measured);

  await $`scripts/dev/dev.sh down`;

  appendFileSync(stepSummary, `\`\`\`json\n${measured.trimEnd()}\n\`\`\`\n`);
}

if (import.meta.main) {
  await main();
}
