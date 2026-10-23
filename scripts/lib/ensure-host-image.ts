import { $ } from 'bun';
import { createHostImage } from './create-host-image.ts';
import type { DevCheckout } from './read-dev-checkout.ts';

export async function ensureHostImage(checkout: DevCheckout, machineID: string): Promise<void> {
  const inspect = await $`docker image inspect ${checkout.hostImage}`.quiet().nothrow();

  if (inspect.exitCode !== 0) {
    await createHostImage($, checkout, machineID);
  }
}
