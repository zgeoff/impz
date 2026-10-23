import invariant from 'tiny-invariant';
import type { BootstrapRun } from './types';

// A step that must work: its failure ends the run with the step's exit code and stderr, as the
// bash script's set -e did. The output comes back without its trailing newlines, as $(...) gave it.
export async function runInContainer(run: BootstrapRun, argv: readonly string[]): Promise<string> {
  const container = run.state.container;

  invariant(container !== null, 'no test container is running');

  const output = await run.io.shell`docker exec ${container} ${[...argv]}`.quiet().text();

  return output.replace(/\n+$/u, '');
}
