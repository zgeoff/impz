import { realpathSync } from 'node:fs';
import { ensureHostImage } from '@impz/scripts/lib/ensure-host-image';
import { readDevCheckout } from '@impz/scripts/lib/read-dev-checkout';
import { readMachineID } from '@impz/scripts/lib/read-machine-id';
import { readTextOrNull } from '@impz/scripts/lib/read-text-or-null';
import type { HarnessEnv } from './config';
import { REPO_ROOT, readHostImageFromEnv, runCommand } from './instance';
import type { ZfsCommandResult } from './zfs-owner';

export async function runHostZfs(
  argv: readonly string[],
  env: HarnessEnv,
): Promise<ZfsCommandResult> {
  await ensureHostImage(
    readDevCheckout(realpathSync, env, REPO_ROOT),
    readMachineID(readTextOrNull, env).id,
    'docker',
  );

  return runCommand(['docker', 'run', '--rm', '--privileged', readHostImageFromEnv(env), ...argv]);
}
