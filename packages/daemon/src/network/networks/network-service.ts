import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressMode, Network, NetworkJoin } from '@impz/api';
import type { ImpCheckpointHooks } from '../../imps/imps/imp-service';
import { listEgressSlots } from '../../platform/db/egress';
import { readImpByName } from '../../platform/db/imps';
import {
  listNetworkMembers,
  listNetworks,
  readNetworkByName,
  removeMember,
  removeNetwork,
  writeMember,
  writeNetwork,
  writeNetworkWithMembers,
} from '../../platform/db/networks';
import type { NetworkRecord } from '../../platform/db/networks';
import type { ImpDatabase } from '../../platform/db/open-database';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildConflictError, buildNotFoundError } from '../../surface/api-errors';
import type { EgressService } from '../egress/egress-service';

export interface NetworkDeps {
  readonly db: ImpDatabase;
  readonly egress: Pick<EgressService, 'changeNetworks'>;

  readonly imps: Pick<ImpCheckpointHooks, 'lockImp'>;
}

export interface NetworkService {
  readonly listNetworks: () => Promise<Network[]>;
  readonly createNetwork: (name: string) => Promise<Network>;
  readonly removeNetwork: (name: string) => Promise<void>;
  readonly joinNetwork: (network: string, imp: string) => Promise<NetworkJoin>;
  readonly leaveNetwork: (network: string, imp: string) => Promise<Network>;

  readonly readTrustWarnings: (imp: string) => Promise<string[]>;

  readonly resolveNetworkIds: (names: readonly string[]) => Promise<string[]>;

  readonly writeMissingNetworks: (
    names: readonly string[],
  ) => Promise<{ readonly ids: readonly string[]; readonly created: readonly string[] }>;

  readonly removeEmptyNetworks: (names: readonly string[]) => Promise<void>;
}

const TRUSTS_OPEN = 'a public, box or none imp trusts its open peers';
const TRUSTS_PUBLIC = 'a box or none imp trusts its public peers';

export function createNetworkService(deps: NetworkDeps): NetworkService {
  const db = deps.db;

  const requireNetwork = async (name: string): Promise<NetworkRecord> => {
    const network = await readNetworkByName(db, name);

    if (network === undefined) {
      throw buildNotFoundError('network', name);
    }

    return network;
  };

  const requireImpId = async (name: string): Promise<string> => {
    const imp = await readImpByName(db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp.id;
  };

  const requireWritten = async (name: string): Promise<NetworkRecord> => {
    const network = await writeNetwork(db, name);

    if (network === null) {
      throw buildConflictError('network', name);
    }

    return network;
  };

  const removeEmpty = async (names: readonly string[]): Promise<void> => {
    for (const name of names) {
      const network = await readNetworkByName(db, name);

      if (network !== undefined && network.imps.length === 0) {
        await removeNetwork(db, network.id);
      }
    }
  };

  const readTrustWarning = async (networkName: string, impName: string): Promise<string | null> => {
    const network = await requireNetwork(networkName);
    const slots = await listEgressSlots(db);

    const modes = new Map(slots.map((slot) => [slot.name, slot.policy.mode]));

    const others = network.imps.filter((name) => name !== impName);
    const mode = modes.get(impName);
    const open = others.filter((name) => isOpen(modes.get(name)));
    const closed = others.filter((name) => !isOpen(modes.get(name)));
    const publics = others.filter((name) => isPublic(modes.get(name)));
    const boxed = others.filter((name) => isBoxOrNone(modes.get(name)));

    if (!isOpen(mode) && open.length > 0) {
      return `${impName} is ${String(mode)}, but ${open.join(', ')} on ${networkName} ${open.length === 1 ? 'is' : 'are'} open and can relay for it: ${TRUSTS_OPEN}`;
    }

    if (isOpen(mode) && closed.length > 0) {
      return `${impName} is open, so ${closed.join(', ')} on ${networkName} can reach anything through it: ${TRUSTS_OPEN}`;
    }

    if (isBoxOrNone(mode) && publics.length > 0) {
      return `${impName} is ${String(mode)}, but ${publics.join(', ')} on ${networkName} ${publics.length === 1 ? 'is' : 'are'} public and can relay for it to the internet: ${TRUSTS_PUBLIC}`;
    }

    if (isPublic(mode) && boxed.length > 0) {
      return `${impName} is public, so ${boxed.join(', ')} on ${networkName} can reach the internet through it: ${TRUSTS_PUBLIC}`;
    }

    return null;
  };

  const readNetwork = async (name: string): Promise<Network> => {
    const network = await requireNetwork(name);

    return toApiNetwork(network);
  };

  return {
    listNetworks: async () => {
      const networks = await listNetworks(db);

      return networks.map((network) => toApiNetwork(network));
    },

    createNetwork: async (name) => {
      const network = await deps.egress.changeNetworks({
        write: () => writeNetwork(db, name),
        undo: async (created) => {
          if (created !== null) {
            await removeNetwork(db, created.id);
          }
        },
      });

      if (network === null) {
        throw buildConflictError('network', name);
      }

      return toApiNetwork(network);
    },

    removeNetwork: async (name) => {
      const network = await requireNetwork(name);

      await deps.egress.changeNetworks({
        write: async () => {
          const members = await listNetworkMembers(db);

          await removeNetwork(db, network.id);

          return members.filter((member) => member.network === name).map((member) => member.impId);
        },
        undo: (impIds) => writeNetworkWithMembers(db, network, impIds),
      });
    },

    joinNetwork: async (networkName, impName) => {
      const network = await requireNetwork(networkName);

      await deps.imps.lockImp(impName, (imp) =>
        deps.egress.changeNetworks({
          write: () => writeMember(db, network.id, imp.id),
          undo: async (added) => {
            if (added) {
              await removeMember(db, network.id, imp.id);
            }
          },
        }),
      );

      const joined = await readNetwork(networkName);
      const warning = await readTrustWarning(networkName, impName);

      return { ...joined, warning };
    },

    leaveNetwork: async (networkName, impName) => {
      const network = await requireNetwork(networkName);
      const impId = await requireImpId(impName);

      await deps.egress.changeNetworks({
        write: () => removeMember(db, network.id, impId),
        undo: async (removed) => {
          if (removed) {
            await writeMember(db, network.id, impId);
          }
        },
      });

      return readNetwork(networkName);
    },

    readTrustWarnings: async (impName) => {
      await requireImpId(impName);

      const networks = await listNetworks(db);

      const warnings: string[] = [];

      for (const network of networks.filter((each) => each.imps.includes(impName))) {
        const warning = await readTrustWarning(network.name, impName);

        if (warning !== null) {
          warnings.push(warning);
        }
      }

      return warnings;
    },

    resolveNetworkIds: async (names) => {
      const ids: string[] = [];

      for (const name of new Set(names)) {
        const network = await requireNetwork(name);

        ids.push(network.id);
      }

      return ids;
    },

    writeMissingNetworks: (names) =>
      deps.egress.changeNetworks({
        write: async () => {
          const ids: string[] = [];
          const created: string[] = [];

          for (const name of new Set(names)) {
            const found = await readNetworkByName(db, name);

            if (found !== undefined) {
              ids.push(found.id);
              continue;
            }

            const network = await requireWritten(name);

            ids.push(network.id);
            created.push(name);
          }

          return { ids, created };
        },
        undo: (written) => removeEmpty(written.created),
      }),

    removeEmptyNetworks: async (names) => {
      await deps.egress.changeNetworks({ write: () => removeEmpty(names), undo: async () => {} });
    },
  };
}

function isOpen(mode: EgressMode | undefined): boolean {
  return mode !== undefined && EGRESS_MODE_TRAITS[mode].isOpen;
}

function isPublic(mode: EgressMode | undefined): boolean {
  return mode !== undefined && EGRESS_MODE_TRAITS[mode].isPublic;
}

function isBoxOrNone(mode: EgressMode | undefined): boolean {
  return (
    mode !== undefined && !EGRESS_MODE_TRAITS[mode].isOpen && !EGRESS_MODE_TRAITS[mode].isPublic
  );
}

function toApiNetwork(network: Readonly<NetworkRecord>): Network {
  return { name: network.name, imps: network.imps, createdAt: network.createdAt };
}
