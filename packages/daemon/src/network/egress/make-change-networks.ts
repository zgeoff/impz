import type { NetworkMember } from '../../platform/db/networks';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { KeyedMutex } from '../../platform/process/keyed-mutex';

export interface NetworkChange<T> {
  readonly write: () => Promise<T>;
  readonly undo: (written: T) => Promise<void>;
}

interface ChangeNetworksDeps {
  readonly mutex: KeyedMutex;
  readonly log: (message: string) => void;
  readonly applyTable: () => Promise<void>;
  readonly tryApplyTable: () => Promise<void>;
  readonly flushPair: (first: string, second: string) => Promise<void>;

  readonly readMembers: () => readonly NetworkMember[];
}

export function makeChangeNetworks(
  deps: ChangeNetworksDeps,
): <T>(change: NetworkChange<T>) => Promise<T> {
  const tryUndo = async (undo: () => Promise<void>): Promise<boolean> => {
    for (const attempt of [1, 2]) {
      try {
        await undo();

        return true;
      } catch (error) {
        deps.log(
          `impd: egress: undoing a network change (try ${String(attempt)}): ${getErrorMessage(error)}`,
        );
      }
    }

    return false;
  };

  return (change) =>
    deps.mutex.runExclusive('policy', async () => {
      const before = listPeerPairs(deps.readMembers());

      const result = await change.write();

      try {
        await deps.applyTable();
      } catch (error) {
        const undone = await tryUndo(() => change.undo(result));

        await deps.tryApplyTable();

        if (!undone) {
          throw new Error(
            `${getErrorMessage(error)}; the network change could not be undone and may have applied`,
            { cause: error },
          );
        }

        throw error;
      }

      const after = listPeerPairs(deps.readMembers());

      for (const pair of before) {
        if (!after.has(pair)) {
          const [first = '', second = ''] = pair.split(' ');

          try {
            await deps.flushPair(first, second);
          } catch (error) {
            deps.log(`impd: egress: ${pair}: ${getErrorMessage(error)}`);
          }
        }
      }

      return result;
    });
}

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
