import { BootstrapTestError } from './bootstrap-test-error';
import { runBootstrap } from './run-bootstrap';
import type { BootstrapCall } from './run-bootstrap';
import type { BootstrapRun, BootstrapTarget } from './types';

interface ExpectedExit extends BootstrapCall {
  readonly want: number;
}

// --check exits 0 when nothing is pending, 2 when changes are pending, and 1 on an error.
export async function expectBootstrapExit(
  run: BootstrapRun,
  target: BootstrapTarget,
  expected: ExpectedExit,
): Promise<string> {
  const result = await runBootstrap(run, target, expected);

  if (result.exitCode !== expected.want) {
    throw new BootstrapTestError(
      `bootstrap.sh ${expected.mode} exited ${String(result.exitCode)}, not ${String(expected.want)}`,
    );
  }

  return result.output;
}
