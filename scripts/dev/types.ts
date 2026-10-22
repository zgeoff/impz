import type { DevEnv, DevLayout } from '../lib/build-dev-layout.ts';
import type { DevCheckout } from '../lib/read-dev-checkout.ts';

export interface Dev {
  readonly env: DevEnv;
  readonly layout: DevLayout;
  readonly checkout: DevCheckout;
}
