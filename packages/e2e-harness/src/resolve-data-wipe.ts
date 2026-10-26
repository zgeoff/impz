import type { HarnessEnv } from './config';
import { REPO_ROOT } from './instance';
import { runHostZfs } from './run-host-zfs';
import { resolveWipeTarget } from './wipe-target';
import type { WipeTarget } from './wipe-target';

export function resolveDataWipe(
  path: string,
  env: HarnessEnv,
  zfsRoot: string | undefined = env['IMP_ZFS_ROOT'],
): Promise<WipeTarget | null> {
  return resolveWipeTarget({
    path,
    repoRoot: REPO_ROOT,
    storageBackend: env['IMP_STORAGE_BACKEND'],
    zfsRoot,
    run: (argv) => runHostZfs(argv, env),
  });
}
