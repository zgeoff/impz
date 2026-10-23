import { match } from 'ts-pattern';
import type { ZfsHostFacts } from './types.ts';

// A generated or fixed name is not ownership, so a pool, a pool file, a data dir, a container or a
// network that is already there is refused, never taken over.
export function findHostRefusal(facts: ZfsHostFacts): string | null {
  return match(facts)
    .with({ module: 'missing' }, () => 'load the zfs module first (sudo modprobe zfs)')
    .with({ module: 'loaded' }, (loaded) => {
      if (loaded.poolExists) {
        return `a pool named ${loaded.pool} already exists; refusing to touch it`;
      }

      const [path] = loaded.existingPaths;

      if (path !== undefined) {
        return `${path} already exists; refusing to touch it`;
      }

      const [container] = loaded.existingContainers;

      if (container !== undefined) {
        return `a container named ${container} already exists; refusing to touch it`;
      }

      const [network] = loaded.existingNetworks;

      if (network !== undefined) {
        return `a network named ${network} already exists; refusing to touch it`;
      }

      return null;
    })
    .exhaustive();
}
