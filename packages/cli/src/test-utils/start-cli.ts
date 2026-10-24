import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StartCliOptions {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const MAIN = join(import.meta.dir, '..', 'main.ts');

export function startCli(options: StartCliOptions) {
  const home = mkdtempSync(join(tmpdir(), 'impz-cli-home-'));

  const child = Bun.spawn(['bun', MAIN, ...options.args], {
    env: { PATH: process.env['PATH'] ?? '', HOME: home, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  void removeOnExit(child.exited, home);

  return child;
}

async function removeOnExit(exited: Promise<number>, directory: string): Promise<void> {
  try {
    await exited;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runCli(options: StartCliOptions): Promise<CliResult> {
  const child = startCli(options);

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}
