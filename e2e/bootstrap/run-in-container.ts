import invariant from 'tiny-invariant';
import type { BootstrapRun } from './types';

export async function runInContainer(run: BootstrapRun, argv: readonly string[]): Promise<string> {
  const container = run.state.container;

  invariant(container !== null, 'no test container is running');

  const output = await run.io.shell`docker exec ${container} ${[...argv]}`.quiet().text();

  return output.replace(/\n+$/u, '');
}
