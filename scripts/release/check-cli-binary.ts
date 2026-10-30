import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';

// The Homebrew formula generates these completions at install time.
const completionShells = ['bash', 'zsh', 'fish'];

async function main(): Promise<void> {
  const target = getStepEnv(process.env, 'TARGET');
  const version = getStepEnv(process.env, 'VERSION');
  const dist = join(getStepEnv(process.env, 'GITHUB_WORKSPACE'), 'dist');

  // a tag from before the CLI's rename builds imp-<target>
  const name = existsSync(join(dist, `impz-${target}`)) ? `impz-${target}` : `imp-${target}`;
  const binary = join(dist, name);

  if (!existsSync(binary)) {
    console.error(`dist/ holds neither impz-${target} nor imp-${target}`);

    process.exitCode = 1;

    return;
  }

  const listed = readFileSync(join(dist, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .find((line) => line.endsWith(`  ${name}`))
    ?.split('  ')[0];

  const sum = new Bun.CryptoHasher('sha256').update(readFileSync(binary)).digest('hex');

  if (listed !== sum) {
    console.error(`${name} has sha256 ${sum}, and SHA256SUMS lists ${listed ?? 'no sum'} for it`);

    process.exitCode = 1;

    return;
  }

  chmodSync(binary, 0o755);

  const printed = await $`${binary} --version`.text();

  const reported = printed.trim();

  if (reported !== version) {
    console.error(`${name} --version is ${reported}, want ${version}`);

    process.exitCode = 1;

    return;
  }

  await Promise.all(completionShells.map((shell) => $`${binary} completion ${shell}`.quiet()));

  console.log(`${name} is ${version}, matches SHA256SUMS and prints its completions`);
}

if (import.meta.main) {
  await main();
}
