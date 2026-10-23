import { BootstrapTestError } from './bootstrap-test-error';
import { readInContainer } from './read-in-container';
import type { BootstrapRun } from './types';

interface ContainerExpectation {
  readonly argv: readonly string[];
  readonly failure: string;

  // A check that holds when the command fails, such as a table that must be gone.
  readonly fails?: boolean;
}

export async function expectInContainer(
  run: BootstrapRun,
  expectation: ContainerExpectation,
): Promise<void> {
  const result = await readInContainer(run, expectation.argv);

  const hasHeld = (result.exitCode === 0) !== (expectation.fails ?? false);

  if (!hasHeld) {
    throw new BootstrapTestError(expectation.failure);
  }
}
