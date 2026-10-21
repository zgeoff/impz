import type { Uplinks } from '../../host-net/net/host-routes';
import { getErrorMessage } from '../../platform/process/get-error-message';

export interface HostNetwork {
  readonly connected4: readonly string[];
  readonly connected6: readonly string[];
  readonly uplinks: Uplinks;

  readonly error: string | null;
}

export interface HostNetworkReaders {
  readonly hasIPv6: boolean;
  readonly readConnected6: () => Promise<readonly string[]>;
  readonly readConnected4: () => Promise<readonly string[]>;
  readonly readUplinks: () => Promise<Uplinks>;
  readonly log: (message: string) => void;
}

const NO_UPLINKS: Uplinks = { ipv4: [], ipv6: [] };

export async function readHostNetwork(
  hasPublic: boolean,
  readers: HostNetworkReaders,
): Promise<HostNetwork> {
  // read at each build: Docker can attach a network to the container later
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
