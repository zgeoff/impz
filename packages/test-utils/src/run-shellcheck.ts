import { onTestFinished } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ShellcheckResult {
  readonly exitCode: number;
  readonly output: string;
}

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
