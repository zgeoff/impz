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

export async function runBootstrap(
  run: BootstrapRun,
  target: BootstrapTarget,
  call: BootstrapCall,
): Promise<BootstrapResult> {
  const container = run.state.container;

  invariant(container !== null, 'no test container is running');

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

  if (result.exitCode === 1 && /^bootstrap: failed: /mu.test(output)) {
    const journal = await run.io
      .shell`docker exec ${container} journalctl -u imp-host --no-pager -n 40`
      .quiet()
      .nothrow();

    run.io.writeStderr(journal.stdout.toString());
  }

  return { exitCode: result.exitCode, output };
}
