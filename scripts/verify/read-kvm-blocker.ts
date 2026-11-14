import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { readDevCheckout } from '../lib/read-dev-checkout.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { pickKvmBlocker } from './pick-kvm-blocker.ts';

// Probes what `scripts/dev/dev.sh up` needs on this machine, and names the first thing missing.
// The kernel follows dev.sh: IMP_KERNEL, else kernel/out/vmlinux, else .cache/vmlinux-ci.
export async function readKvmBlocker(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const built = join(REPO_ROOT, 'kernel', 'out', 'vmlinux');
  const setting = env['IMP_KERNEL'] ?? '';

  const hasBuilt = await probeAccess(built, constants.R_OK);

  const fallback = hasBuilt ? built : join(REPO_ROOT, '.cache', 'vmlinux-ci');
  const kernelPath = setting === '' ? fallback : setting;

  const root = await realpath(REPO_ROOT);

  const hostImage = readDevCheckout(() => root, env, REPO_ROOT).hostImage;

  const docker = await $`docker info --format '{{.ServerVersion}}'`.quiet().nothrow();
  const image = await $`docker image inspect ${hostImage}`.quiet().nothrow();

  return pickKvmBlocker({
    hasKvm: await probeAccess('/dev/kvm', constants.R_OK | constants.W_OK),
    hasDocker: docker.exitCode === 0,
    kernelPath,
    hasKernel: await probeAccess(kernelPath, constants.R_OK),
    hostImage,
    hasHostImage: image.exitCode === 0,
  });
}

async function probeAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);

    return true;
  } catch {
    return false;
  }
}
