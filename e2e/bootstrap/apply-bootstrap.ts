import { BootstrapTestError } from './bootstrap-test-error';
import { runBootstrap } from './run-bootstrap';
import type { BootstrapRun, BootstrapTarget } from './types';

interface ApplyCall {
  readonly extra?: readonly string[];
  readonly failure: string;
}

// A bootstrap.sh --yes run that must succeed; its output comes back for the checks after it.
export async function applyBootstrap(
  run: BootstrapRun,
  target: BootstrapTarget,
  call: ApplyCall,
): Promise<string> {
  const result = await runBootstrap(run, target, { mode: '--yes', extra: call.extra ?? [] });

  if (result.exitCode !== 0) {
    throw new BootstrapTestError(`[${target.distro}] ${call.failure}`);
  }

  return result.output;
}
