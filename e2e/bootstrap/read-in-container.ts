import invariant from 'tiny-invariant';
import type { BootstrapRun } from './types';

interface ContainerRead {
  readonly exitCode: number;
  readonly output: string;
}

// A step whose failure is an answer, not an error: the output comes back without its trailing
// newlines, as $(...) gave it, with the exit code beside it.
export async function readInContainer(
  run: BootstrapRun,
  argv: readonly string[],
): Promise<ContainerRead> {
  const container = run.state.container;

  invariant(container !== null, 'no test container is running');

  const result = await run.io.shell`docker exec ${container} ${[...argv]}`.quiet().nothrow();

  return { exitCode: result.exitCode, output: result.stdout.toString().replace(/\n+$/u, '') };
}
