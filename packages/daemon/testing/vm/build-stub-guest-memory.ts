import type { ImpPaths } from '../../src/vm/storage/data-layout';
import type { GuestMemory } from '../../src/vm/vmm/vm-runner';

interface StubGuest {
  baseMib: number;
  pluggedMib: number;
  requestedMib: number;
  usedMib: number;

  regionMib: number;

  unplugFloorMib: number;

  isSlow: boolean;

  pluggedOnReads: readonly number[];

  isAnswerLost: boolean;

  lostReadsAfterRequest: number;

  staleStats: { readonly totalMib: number; readonly availableMib: number } | null;
}

const BLOCK_MIB = 2;

export function buildStubGuestMemory() {
  const guests = new Map<string, StubGuest>();

  const requests: number[] = [];

  const lostReads = new Map<string, number>();

  const readGuest = (paths: Pick<ImpPaths, 'directory'>): Promise<StubGuest> => {
    const guest = guests.get(paths.directory);

    return guest === undefined ? Promise.reject(new Error('no such VM')) : Promise.resolve(guest);
  };

  return {
    requests,

    addGuest: (paths: Pick<ImpPaths, 'directory'>, guest: Partial<StubGuest> = {}): StubGuest => {
      const added: StubGuest = {
        baseMib: 512,
        pluggedMib: 0,
        requestedMib: 0,
        usedMib: 300,
        regionMib: 1024,
        unplugFloorMib: 0,
        isSlow: false,
        pluggedOnReads: [],
        isAnswerLost: false,
        lostReadsAfterRequest: 0,
        staleStats: null,
        ...guest,
      };

      guests.set(paths.directory, added);

      return added;
    },
    vms: {
      readGuestMemory: async (paths: Pick<ImpPaths, 'directory'>): Promise<GuestMemory> => {
        const guest = await readGuest(paths);

        const lost = lostReads.get(paths.directory) ?? 0;

        if (lost > 0) {
          lostReads.set(paths.directory, lost - 1);
          throw new Error('firecracker GET /hotplug/memory: no answer within 1000 ms');
        }

        const [scriptedMib, ...laterMib] = guest.pluggedOnReads;

        guest.pluggedOnReads = laterMib;

        if (scriptedMib !== undefined) {
          guest.pluggedMib = scriptedMib;
        } else if (!guest.isSlow) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            Math.min(guest.pluggedMib, guest.unplugFloorMib),
          );
        }

        const totalMib = guest.baseMib + guest.pluggedMib;

        return {
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          ...(guest.staleStats ?? { totalMib, availableMib: totalMib - guest.usedMib }),
        };
      },

      // Firecracker's PATCH /hotplug/memory takes whole blocks within the
      // region and answers 400 to anything else
      requestPluggedMib: async (paths: Pick<ImpPaths, 'directory'>, mib: number): Promise<void> => {
        const guest = await readGuest(paths);

        if (!Number.isInteger(mib / BLOCK_MIB) || mib < 0 || mib > guest.regionMib) {
          throw new Error(
            `firecracker PATCH /hotplug/memory: 400 requested size ${String(mib)} MiB is not whole blocks within the region`,
          );
        }

        guest.requestedMib = mib;

        requests.push(mib);
        lostReads.set(paths.directory, guest.lostReadsAfterRequest);

        if (guest.isAnswerLost) {
          throw new Error('firecracker PATCH /hotplug/memory: no answer within 1000 ms');
        }
      },
    },
  };
}
