import type { NetworkMember } from '../../platform/db/networks';
import type { KeyedMutex } from '../../platform/process/keyed-mutex';
import { readErrorMessage } from '../../platform/process/read-error-message';

// A table nft refuses runs `undo`, so the rows and the table agree. Imps the
// change parts lose their connections to each other.
export interface NetworkChange<T> {
  readonly write: () => Promise<T>;
  readonly undo: (written: T) => Promise<void>;
}

// what a network change needs of the rest of the egress service
interface ChangeNetworksDeps {
  readonly mutex: KeyedMutex;
  readonly log: (message: string) => void;
  readonly applyTable: () => Promise<void>;
  readonly tryApplyTable: () => Promise<void>;
  readonly flushPair: (first: string, second: string) => Promise<void>;

  // the networks' members as of the last table
  readonly readMembers: () => readonly NetworkMember[];
}

export function makeChangeNetworks(
  deps: ChangeNetworksDeps,
): <T>(change: NetworkChange<T>) => Promise<T> {
  // an undo, tried twice; false when both throw, so the rows may still hold
  // the change
  const tryUndo = async (undo: () => Promise<void>): Promise<boolean> => {
    for (const attempt of [1, 2]) {
      try {
        await undo();

        return true;
      } catch (error) {
        deps.log(
          `impd: egress: undoing a network change (try ${String(attempt)}): ${readErrorMessage(error)}`,
        );
      }
    }

    return false;
  };

  return (change) =>
    deps.mutex.runExclusive('policy', async () => {
      const before = listPeerPairs(deps.readMembers());

      const result = await change.write();

      // The rows go back, then the table is built again from whatever the
      // rows say: an undo that throws leaves the change in the rows, and the
      // table follows them, so a failed leave never keeps a pair connected.
      try {
        await deps.applyTable();
      } catch (error) {
        const undone = await tryUndo(() => change.undo(result));

        await deps.tryApplyTable();

        if (!undone) {
          throw new Error(
            `${readErrorMessage(error)}; the network change could not be undone and may have applied`,
            { cause: error },
          );
        }

        throw error;
      }

      // the table refuses their next packet already; this drops the flows
      // conntrack still holds for them
      const after = listPeerPairs(deps.readMembers());

      for (const pair of before) {
        if (!after.has(pair)) {
          const [first = '', second = ''] = pair.split(' ');

          try {
            await deps.flushPair(first, second);
          } catch (error) {
            deps.log(`impd: egress: ${pair}: ${readErrorMessage(error)}`);
          }
        }
      }

      return result;
    });
}

// every two addresses that share a network, as `low high`
function listPeerPairs(members: readonly NetworkMember[]): Set<string> {
  const pairs = new Set<string>();

  for (const group of Map.groupBy(members, (member) => member.network).values()) {
    for (const first of group) {
      for (const second of group) {
        if (first.guestIp < second.guestIp) {
          pairs.add(`${first.guestIp} ${second.guestIp}`);
        }
      }
    }
  }

  return pairs;
}
