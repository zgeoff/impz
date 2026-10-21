import type { Identity, SystemInfo } from '@impz/api';
import { buildMockIdentity } from '@impz/api/test-utils/build-mock-identity';
import { buildMockSystemInfo } from '@impz/api/test-utils/build-mock-system-info';
import type { HostProbe } from '../hosts/place-imp';

type OptionalInfoKey = {
  [K in keyof SystemInfo]-?: undefined extends SystemInfo[K] ? K : never;
}[keyof SystemInfo];

interface HostProbeOverrides {
  readonly info?: Parameters<typeof buildMockSystemInfo>[0];
  readonly withoutInfo?: readonly OptionalInfoKey[];
  readonly identity?: Partial<Identity>;
  readonly images?: readonly string[];
  readonly imps?: readonly string[];
  readonly networks?: readonly string[];
}

export function buildMockHostProbe(overrides: Readonly<HostProbeOverrides> = {}): HostProbe {
  const info: SystemInfo = { ...buildMockSystemInfo(overrides.info) };

  for (const key of overrides.withoutInfo ?? []) {
    Reflect.deleteProperty(info, key);
  }

  const image = info.defaults?.image;

  return {
    info,
    identity: buildMockIdentity(overrides.identity),
    images: overrides.images ?? (image === undefined || image === null ? [] : [image]),
    imps: overrides.imps ?? [],
    networks: overrides.networks ?? [],
  };
}
