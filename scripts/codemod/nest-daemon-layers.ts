// Moves impd's folders under one folder per layer and rewrites every path that names them. A run
// on its own output changes nothing, so a branch that conflicts with the move merges main and runs
// it again. Usage: bun scripts/codemod/nest-daemon-layers.ts [repo root, default the cwd]
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyLayerMoves } from './apply-layer-moves';

const OXFMT = join(import.meta.dir, '..', '..', 'node_modules', '.bin', 'oxfmt');

// the release notes keep the paths that each release had, and the codemod keeps its own fixtures
const SKIPPED_FILES = /(?:^|\/)CHANGELOG\.md$|^bun\.lock$|^scripts\/codemod\//u;

// the files that the pre-commit hook formats with oxfmt
const FORMATTED_FILE = /\.(?:[cm]?[jt]sx?|jsonc?|md|css|ya?ml|html)$/u;

function main(): void {
  const root = resolve(process.argv[2] ?? process.cwd());

  const listed = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root },
  );

  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }

  const files = [...new Set(listed.stdout.toString().split('\0'))].filter(
    (file) => file !== '' && !SKIPPED_FILES.test(file) && existsSync(join(root, file)),
  );

  const report = applyLayerMoves(root, files);

  for (const [from, to] of report.collisions) {
    console.error(`collision: ${from} moves to ${to}, which a file already holds`);
  }

  if (report.collisions.length > 0) {
    console.error('moved no file: merge or remove each colliding pair, then run again');

    process.exitCode = 1;

    return;
  }

  console.log(`moved ${report.moved.length} files, rewrote ${report.rewritten.length} files`);

  // a longer path can push a line past the width, so the rewritten files are formatted again
  const formattable = report.rewritten.filter((file) => FORMATTED_FILE.test(file));

  if (formattable.length > 0) {
    const formatted = Bun.spawnSync([OXFMT, '--no-error-on-unmatched-pattern', ...formattable], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // a run on this output rewrites nothing and so formats nothing, so this run reports it
    if (formatted.exitCode !== 0) {
      console.error(`oxfmt exited ${String(formatted.exitCode)}; fix and format these files:`);

      for (const file of formattable) {
        console.error(`  ${file}`);
      }

      process.exitCode = 1;
    }
  }

  for (const file of report.unplaced) {
    console.error(`unplaced: ${file} (add it to the layer table in plan-layer-path.ts)`);
  }

  if (report.unplaced.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
