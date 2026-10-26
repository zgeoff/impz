import { $ } from 'bun';
import type { ContainerCLI } from './build-dev-layout.ts';
import { createHostImage } from './create-host-image.ts';
import type { DevCheckout } from './read-dev-checkout.ts';
import { requirePodmanHostImage } from './require-podman-host-image.ts';

export async function ensureHostImage(
  checkout: DevCheckout,
  machineID: string,
  containerCLI: ContainerCLI,
): Promise<void> {
  if (containerCLI === 'podman') {
    await requirePodmanHostImage($, checkout.hostImage);

    return;
  }

  const inspect = await $`docker image inspect ${checkout.hostImage}`.quiet().nothrow();

  if (inspect.exitCode !== 0) {
    await createHostImage($, checkout, machineID);
  }
}
