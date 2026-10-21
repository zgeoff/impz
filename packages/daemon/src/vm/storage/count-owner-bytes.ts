import { EXTENT_FLAGS } from './fiemap';
import type { Extent } from './fiemap';

export interface OwnedFile {
  readonly owner: string;
  readonly extents: readonly Extent[];
}

export interface OwnerBytes {
  readonly exclusiveBytes: number;
  readonly sharedBytes: number;
}

export function countOwnerBytes(files: readonly OwnedFile[]): Map<string, OwnerBytes> {
  const totals = new Map<string, { exclusiveBytes: number; sharedBytes: number }>();

  const readTotal = (owner: string) => {
    const found = totals.get(owner);

    if (found !== undefined) {
      return found;
    }

    const created = { exclusiveBytes: 0, sharedBytes: 0 };

    totals.set(owner, created);

    return created;
  };

  const events: { at: number; owner: string; step: 1 | -1 }[] = [];

  for (const file of files) {
    const total = readTotal(file.owner);

    for (const extent of file.extents) {
      // FIEMAP gives a delayed allocation no physical address yet, so no other file shares it
      if (
        (extent.flags & EXTENT_FLAGS.shared) === 0 ||
        (extent.flags & EXTENT_FLAGS.delalloc) !== 0
      ) {
        total.exclusiveBytes += extent.length;
      } else {
        events.push(
          { at: extent.physical, owner: file.owner, step: 1 },
          { at: extent.physical + extent.length, owner: file.owner, step: -1 },
        );
      }
    }
  }

  events.sort((left, right) => left.at - right.at);

  const covering = new Map<string, number>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const next = events[index + 1];

    if (event === undefined) {
      break;
    }

    covering.set(event.owner, (covering.get(event.owner) ?? 0) + event.step);

    if (covering.get(event.owner) === 0) {
      covering.delete(event.owner);
    }

    const length = next === undefined ? 0 : next.at - event.at;

    if (length > 0 && covering.size > 0) {
      for (const owner of covering.keys()) {
        const total = readTotal(owner);

        if (covering.size === 1) {
          total.exclusiveBytes += length;
        } else {
          total.sharedBytes += length;
        }
      }
    }
  }

  return totals;
}
