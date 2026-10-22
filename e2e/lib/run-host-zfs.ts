import { ensureHostImage } from '../../scripts/lib/ensure-host-image.ts';
import { readDevCheckout } from '../../scripts/lib/read-dev-checkout.ts';
import { readMachineID } from '../../scripts/lib/read-machine-id.ts';
import { REPO_ROOT, readHostImageFromEnv, runCommand } from './instance';
import type { ZfsCommandResult } from './zfs-owner';

export async function runHostZfs(argv: readonly string[]): Promise<ZfsCommandResult> {
  await ensureHostImage(readDevCheckout(process.env, REPO_ROOT), readMachineID(process.env).id);

  return runCommand(['docker', 'run', '--rm', '--privileged', readHostImageFromEnv(), ...argv]);
}
