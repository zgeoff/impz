// Checks that build-formula.sh prints a formula Ruby parses. It runs here, not in a unit test,
// because a cold `ruby` start on a busy CI runner can pass the unit limit.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'imp-formula-ruby-'));

try {
  const sums = join(directory, 'SHA256SUMS');
  const formula = join(directory, 'imp.rb');

  writeFileSync(
    sums,
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
      .map((platform, index) => `${String(index).repeat(64)}  impz-${platform}\n`)
      .join(''),
  );

  const build = Bun.spawnSync(['bash', join(import.meta.dir, 'build-formula.sh'), '1.2.3', sums], {
    stderr: 'inherit',
  });

  if (build.exitCode !== 0) {
    throw new Error(`build-formula.sh exited ${String(build.exitCode)}`);
  }

  writeFileSync(formula, build.stdout);

  const check = Bun.spawnSync(['ruby', '-c', formula], { env: process.env });
  const output = `${check.stdout.toString()}${check.stderr.toString()}`.trim();

  if (check.exitCode !== 0) {
    throw new Error(`ruby -c refused the formula: ${output}`);
  }

  console.log(`formula: ${output}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
