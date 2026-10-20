import { getErrorMessage } from '../get-error-message';
import type { Uplinks } from '../net/host-routes';

// the host container's networks and default routes, read for a table build
export interface HostNetwork {
  readonly connected4: readonly string[];
  readonly connected6: readonly string[];
  readonly uplinks: Uplinks;

  // a read that failed while some imp is public; its imps then reach
  // nothing, and none starts
  readonly error: string | null;
}

// what the read reaches the host through
export interface HostNetworkReaders {
  readonly hasIPv6: boolean;
  readonly readConnected6: () => Promise<readonly string[]>;
  readonly readConnected4: () => Promise<readonly string[]>;
  readonly readUplinks: () => Promise<Uplinks>;
  readonly log: (message: string) => void;
}

// No interface: a public imp's traffic leaves by none
const NO_UPLINKS: Uplinks = { ipv4: [], ipv6: [] };

// The container's own links, read now: a network can join it later. The
// IPv4 side and the uplinks only matter while some imp is public. A read
// that fails then leaves public imps no uplink: the table refuses them all.
export async function readHostNetwork(
  hasPublic: boolean,
  readers: HostNetworkReaders,
): Promise<HostNetwork> {
  try {
    return {
      connected6: readers.hasIPv6 ? await readers.readConnected6() : [],
      connected4: hasPublic ? await readers.readConnected4() : [],
      uplinks: hasPublic ? await readers.readUplinks() : NO_UPLINKS,
      error: null,
    };
  } catch (error) {
    const message = getErrorMessage(error);

    readers.log(`impd: egress: reading the host container's routes: ${message}`);

    return {
      connected6: [],
      connected4: [],
      uplinks: NO_UPLINKS,
      error: hasPublic ? message : null,
    };
  }
}
