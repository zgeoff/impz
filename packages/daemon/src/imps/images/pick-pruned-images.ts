import type { ImageUse } from '../../platform/db/images';

// An imp create resolves its image before it writes the imp's row, and a restore or a move
// picks its image well before that, so an image used this recently may be about to gain an imp.
export const RECENT_USE_MS = 3_600_000;

export interface PruneRule {
  readonly prefix: string;
  readonly rollbackCount: number;
}

export interface PrunePlan {
  readonly usedIDs: readonly string[];
  readonly removed: readonly ImageUse[];
}

export function pickPrunedImages(
  uses: readonly ImageUse[],
  keptNames: ReadonlySet<string>,
  rule: Readonly<PruneRule>,
  now: number,
): PrunePlan {
  const isUsed = (use: Readonly<ImageUse>) => use.impCount > 0 || keptNames.has(use.name);

  const unused = uses
    .filter((use) => use.source === 'oci' && use.name.startsWith(rule.prefix) && !isUsed(use))
    .toSorted(
      (left, right) => right.lastUsedAt - left.lastUsedAt || right.name.localeCompare(left.name),
    );

  return {
    usedIDs: uses.filter((use) => isUsed(use)).map((use) => use.id),
    removed: unused
      .slice(rule.rollbackCount)
      .filter((use) => now - use.lastUsedAt >= RECENT_USE_MS),
  };
}
