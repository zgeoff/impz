import invariant from 'tiny-invariant';
import { BootstrapTestError } from './bootstrap-test-error';
import { buildBootstrapArgv } from './build-bootstrap-argv';
import type { BootstrapMode } from './build-bootstrap-argv';
import { formatKernelStateDiff } from './format-kernel-state-diff';
import { readKernelState } from './read-kernel-state';
import type { BootstrapRun, BootstrapTarget } from './types';

export interface BootstrapCall {
  readonly mode: BootstrapMode;
  readonly extra?: readonly string[];
  readonly image?: string;
}

interface BootstrapResult {
  readonly exitCode: number;
  readonly output: string;
}

// Every run is bracketed by a snapshot of the host's kernel state, and a difference fails the test.
export async function runBootstrap(
  run: BootstrapRun,
  target: BootstrapTarget,
  call: BootstrapCall,
): Promise<BootstrapResult> {
  const container = run.state.container;

  invariant(container, 'no test container is running');

  const argv = buildBootstrapArgv({
    mode: call.mode,
    storage: target.storage,
    extra: call.extra ?? [],
    image: call.image ?? run.image,
    health: target.health,
    stub: run.args.stub,
  });

  const before = await readKernelState(run.io);

  const result = await run.io.shell`docker exec ${container} /root/bootstrap.sh ${[...argv]} 2>&1`
    .quiet()
    .nothrow();

  const after = await readKernelState(run.io);

  const output = result.stdout.toString().replace(/\n+$/u, '');

  for (const line of output.split('\n')) {
    run.io.writeStdout(`  | ${line}`);
  }

  const diff = formatKernelStateDiff({ before, after });

  if (diff !== '') {
    run.io.writeStderr(diff);

    throw new BootstrapTestError(
      `the host's kernel state changed during bootstrap.sh ${call.mode}`,
    );
  }

  // A change that failed, such as a restart of imp-host: show why.
  if (result.exitCode === 1 && /^bootstrap: failed: /mu.test(output)) {
    for (const unit of ['imp-host', 'docker']) {
      const journal = await run.io
        .shell`docker exec ${container} journalctl -u ${unit} --no-pager -n 40`
        .quiet()
        .nothrow();

      run.io.writeStderr(journal.stdout.toString());
    }
  }

  return { exitCode: result.exitCode, output };
}
