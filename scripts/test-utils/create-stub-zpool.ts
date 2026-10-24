import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface ZpoolStubOptions {
  readonly create?: 'fails' | { readonly startedMarker: string; readonly release: string };

  // busy fails the destroy as zpool does for a pool that a dataset hold keeps.
  readonly destroy?:
    | 'fails'
    | 'busy'
    | 'ignored'
    | { readonly startedMarker: string; readonly release: string };

  // Once a pool exists, list -H and status fail, as when zpool or sudo cannot reach the kernel.
  readonly queries?: 'fail';
}

export function createStubZpool(stubs: string, options: Readonly<ZpoolStubOptions> = {}): StubBin {
  const held = typeof options.create === 'object' ? options.create : undefined;
  let create = options.create === 'fails' ? 'fails' : '';

  if (held !== undefined) {
    create = 'held';
  }

  const heldDestroy = typeof options.destroy === 'object' ? options.destroy : undefined;
  const destroy = typeof options.destroy === 'string' ? options.destroy : '';

  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, 'zpool.create'), `${create}\n`);
  writeFileSync(join(stubs, 'zpool.create-started'), `${held?.startedMarker ?? ''}\n`);
  writeFileSync(join(stubs, 'zpool.create-release'), `${held?.release ?? ''}\n`);
  writeFileSync(join(stubs, 'zpool.destroy'), `${heldDestroy === undefined ? destroy : 'held'}\n`);
  writeFileSync(join(stubs, 'zpool.destroy-started'), `${heldDestroy?.startedMarker ?? ''}\n`);
  writeFileSync(join(stubs, 'zpool.destroy-release'), `${heldDestroy?.release ?? ''}\n`);
  writeFileSync(join(stubs, 'zpool.queries'), `${options.queries ?? ''}\n`);
  copyFileSync(join(import.meta.dir, 'run-stub-zpool.sh'), join(stubs, 'zpool.sh'));

  return createStubBin(stubs, 'zpool', '. "$(dirname "$STUB_CALLS")/zpool.sh"');
}
