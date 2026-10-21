import type { GuestMemory } from '../../src/vm/vmm/vm-runner';

interface StubElasticGuestOptions {
  readonly baseMib: number;
  readonly usedMib: number;
  readonly pluggedMib: number;
  readonly requestedMib: number;

  readonly regionMib: number;

  readonly stepMib: number;

  readonly floorMib?: number;
}

export function buildStubElasticGuest(options: Readonly<StubElasticGuestOptions>) {
  const floorMib = options.floorMib ?? 0;
  const guest = { pluggedMib: options.pluggedMib, requestedMib: options.requestedMib };
  const requests: number[] = [];

  return {
    guest,
    requests,
    vm: {
      readGuestMemory: (): Promise<GuestMemory> => {
        if (guest.requestedMib < guest.pluggedMib) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            floorMib,
            guest.pluggedMib - options.stepMib,
          );
        }

        return Promise.resolve({
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          totalMib: options.baseMib + guest.pluggedMib,
          availableMib: options.baseMib + guest.pluggedMib - options.usedMib,
        });
      },

      // Firecracker's PATCH /hotplug/memory takes whole 2 MiB blocks within
      // the region and answers 400 to anything else
      requestPluggedMib: (_paths: unknown, mib: number): Promise<void> => {
        if (!Number.isInteger(mib / 2) || mib < 0 || mib > options.regionMib) {
          return Promise.reject(
            new Error(
              `firecracker PATCH /hotplug/memory: 400 requested size ${String(mib)} MiB is not whole blocks within the region`,
            ),
          );
        }

        guest.requestedMib = mib;

        requests.push(mib);

        return Promise.resolve();
      },
    },
  };
}
