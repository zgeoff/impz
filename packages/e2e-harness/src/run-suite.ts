export interface RunSuiteOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;

  readonly onStart: (pid: number) => void;
}

export function runSuite(options: Readonly<RunSuiteOptions>): Promise<number> {
  const subprocess = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    detached: true,
    stdout: 'inherit',
    stderr: 'inherit',
    env: options.env,
  });

  options.onStart(subprocess.pid);

  return subprocess.exited;
}

export function stopSuiteGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
      throw error;
    }
  }
}
