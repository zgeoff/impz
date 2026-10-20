import { onTestFinished } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ShellcheckResult {
  readonly exitCode: number;

  // shellcheck's findings, empty when it has none
  readonly output: string;
}

// Runs shellcheck, with no .shellcheckrc, over a script that production code
// holds as text, in a temp file the test's end removes. The dialect is the
// shell that runs the script, which carries no shebang to name it.
export function runShellcheck(script: string, dialect: 'sh' | 'bash'): ShellcheckResult {
  const directory = mkdtempSync(join(tmpdir(), 'imp-shellcheck-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'script'), script);

  const run = Bun.spawnSync(['shellcheck', '--norc', `--shell=${dialect}`, 'script'], {
    cwd: directory,
  });

  return { exitCode: run.exitCode, output: run.stdout.toString() };
}
