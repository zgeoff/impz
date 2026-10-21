import { LIB_SCRIPT, readHostImageFromEnv, runChecked, runCommand } from './instance';
import type { ZfsCommandResult } from './zfs-owner';

export async function runHostZfs(argv: readonly string[]): Promise<ZfsCommandResult> {
  await runChecked(['bash', '-c', 'source "$1" && ensure_host_image', 'bash', LIB_SCRIPT]);

  return runCommand(['docker', 'run', '--rm', '--privileged', readHostImageFromEnv(), ...argv]);
}
