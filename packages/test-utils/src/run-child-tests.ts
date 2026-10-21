import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ChildTestRun {
  readonly exitCode: number | null;
  readonly isTimedOut: boolean;
  readonly output: string;
}

// The default deadline stays under bun test's 5 s per-test timeout.
export function runChildTests(directory: string, source: string, timeoutMs = 4000): ChildTestRun {
  writeFileSync(join(directory, 'child.test.ts'), source);

  const result = Bun.spawnSync([process.execPath, 'test', './child.test.ts'], {
    cwd: directory,
    env: { ...process.env, TMPDIR: directory },
    timeout: timeoutMs,
  });

  return {
    exitCode: result.exitCode,
    isTimedOut: result.exitedDueToTimeout === true,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}
