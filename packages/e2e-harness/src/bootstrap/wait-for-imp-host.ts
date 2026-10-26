import { waitFor } from '@impz/test-utils/wait-for';
import { readInContainer } from './read-in-container';
import type { BootstrapRun } from './types';

export async function waitForImpHost(run: BootstrapRun): Promise<boolean> {
  try {
    await waitFor(
      async () => {
        const inspect = await readInContainer(run, [
          'podman',
          'container',
          'inspect',
          '-f',
          '{{.State.Running}}',
          'imp-host',
        ]);

        if (inspect.output !== 'true') {
          throw new Error('imp-host is not running');
        }
      },
      { intervalMs: 1000, timeoutMs: 30_000, now: run.io.now, wait: run.io.sleep },
    );

    return true;
  } catch {
    const journal = await readInContainer(run, [
      'journalctl',
      '-u',
      'imp-host',
      '--no-pager',
      '-n',
      '20',
    ]);

    run.io.writeStderr(`${journal.output}\n`);

    return false;
  }
}
