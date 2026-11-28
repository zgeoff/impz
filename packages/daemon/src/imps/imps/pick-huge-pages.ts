import type { HugePages } from '../../vm/vmm/firecracker-client';
import type { ImpsConfig } from '../imps-config';

interface PageShape {
  readonly memoryMib: number;
  readonly maxMemoryMib: number;
}

interface PageSettings {
  // the host has the 2 MiB pool and the page handler
  readonly isOn: boolean;

  // an elastic imp may ask for transparent huge pages
  readonly isElasticTransparent: boolean;
}

// Firecracker refuses a huge-page guest whose memory is not a whole number of huge pages, and an
// elastic imp grows in whole 2 MiB blocks. An elastic imp cannot take the pool, because its
// hot-plugged memory has no pool pages, so it takes the host's transparent huge pages.
export function pickHugePages(
  settings: Readonly<PageSettings>,
  imp: Readonly<PageShape>,
): HugePages {
  if (imp.memoryMib % 2 !== 0) {
    return 'None';
  }

  if (imp.maxMemoryMib > imp.memoryMib) {
    return settings.isElasticTransparent && imp.maxMemoryMib % 2 === 0 ? 'Transparent' : 'None';
  }

  return settings.isOn ? '2M' : 'None';
}

// A kernel without transparent huge pages refuses Firecracker's madvise, which fails the boot,
// so the host's own kernel decides whether the setting takes effect.
export function readPageSettings(
  context: Readonly<{
    config: Pick<ImpsConfig, 'hugePages' | 'isElasticTransparentHugePages'>;
    probeTransparentHugePages: () => boolean;
  }>,
): PageSettings {
  return {
    isOn: context.config.hugePages !== null,
    isElasticTransparent:
      context.config.isElasticTransparentHugePages && context.probeTransparentHugePages(),
  };
}
