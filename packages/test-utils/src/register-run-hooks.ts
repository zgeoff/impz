import { afterEach } from 'bun:test';
import { removeEnvOverrides } from './remove-env-overrides';
import { setFakerSeed } from './set-faker-seed';

export function registerRunHooks(): void {
  setFakerSeed();

  afterEach(() => {
    removeEnvOverrides();
  });
}
