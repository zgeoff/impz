import type { VmConfig } from '../../vm/vm-config';
import type { HugePages } from '../../vm/vmm/firecracker-client';

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

// Firecracker refuses a huge-page guest whose memory is not a whole number of
// huge pages. An elastic imp cannot take the pool, because its hot-plugged
// memory has no pool pages, so it takes the host's transparent huge pages.
export function pickHugePages(
  settings: Readonly<PageSettings>,
  imp: Readonly<PageShape>,
): HugePages {
  if (imp.memoryMib % 2 !== 0) {
    return 'None';
  }

  if (imp.maxMemoryMib > imp.memoryMib) {
    return settings.isElasticTransparent ? 'Transparent' : 'None';
  }

  return settings.isOn ? '2M' : 'None';
}

export function buildPageSettings(
  config: Pick<VmConfig, 'hugePages' | 'isElasticTransparentHugePages'>,
): PageSettings {
  return {
    isOn: config.hugePages !== null,
    isElasticTransparent: config.isElasticTransparentHugePages,
  };
}
