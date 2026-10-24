import { parseKernelState } from './parse-kernel-state';
import type { BootstrapIO } from './types';

export async function readKernelState(io: BootstrapIO): Promise<readonly string[]> {
  const sysctl = await io.shell`sysctl -a`.quiet().nothrow();

  return parseKernelState({
    sysctl: sysctl.stdout.toString(),
    modules: io.readText('/proc/modules'),
  });
}
