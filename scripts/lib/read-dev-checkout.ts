import { join } from 'node:path';
import { buildDevImageTag } from './build-dev-image-tag.ts';
import type { DevEnv } from './build-dev-layout.ts';
import { pickSetting } from './pick-setting.ts';

export interface DevCheckout {
  readonly root: string;
  readonly rootPhysical: string;
  readonly hostImage: string;
  readonly buildDir: string;
}

// The tag and the label take the path without symlinks, so every way to reach the checkout names
// one image.
export function readDevCheckout(
  readRealPath: (path: string) => string,
  env: DevEnv,
  root: string,
): DevCheckout {
  const rootPhysical = readRealPath(root);

  return {
    root,
    rootPhysical,
    hostImage: pickSetting(env, 'IMP_HOST_IMAGE') ?? buildDevImageTag(rootPhysical),
    buildDir: pickSetting(env, 'IMP_BUILD') ?? join(root, 'build'),
  };
}
