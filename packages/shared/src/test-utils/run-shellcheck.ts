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

  const startedMs = performance.now();

  const run = Bun.spawnSync(['shellcheck', '--norc', `--shell=${dialect}`, 'script'], {
    cwd: directory,
    env: process.env,
  });

  // a signal leaves exitCode null whatever its type says, which reads as a finding
  if (run.signalCode !== undefined) {
    const elapsedMs = Math.round(performance.now() - startedMs);

    throw new Error(`shellcheck ended on ${String(run.signalCode)} after ${String(elapsedMs)} ms`);
  }

  return { exitCode: run.exitCode, output: run.stdout.toString() };
}
