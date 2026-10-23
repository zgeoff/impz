import type { DevEnv } from './build-dev-layout.ts';

export type OpReader = (ref: string) => Promise<string>;

const OP_TIMEOUT_MS = 20_000;

// stdin closed and a deadline: a locked desktop app must not hang a run. A failed read gives ''.
export function makeOpReader(env: DevEnv): OpReader | null {
  const op = Bun.which('op', { PATH: env['PATH'] ?? '' });

  if (op === null) {
    return null;
  }

  return async (ref) => {
    const subprocess = Bun.spawn([op, 'read', ref], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...env },
      timeout: OP_TIMEOUT_MS,
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);

    return exitCode === 0 ? stdout.replace(/\n+$/u, '') : '';
  };
}
