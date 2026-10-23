import type { ImageUse } from '../../../platform/db/images';
import type { ImageSpace } from '../../../vm/storage/storage-backend';
import type { ImageEvictionConfig } from '../../imps-config';
import { isOverHighMark } from './is-over-high-mark';

export interface EvictionState {
  readonly uses: readonly ImageUse[];
  readonly keptNames: ReadonlySet<string>;
  readonly spaces: ReadonlyMap<string, ImageSpace>;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly now: number;
}

export function pickEvictedImages(
  state: Readonly<EvictionState>,
  marks: Readonly<ImageEvictionConfig>,
): ImageUse[] {
  if (!isOverHighMark(state, marks)) {
    return [];
  }

  const totalBytes = state.usedBytes + state.availableBytes;
  const excessBytes = state.usedBytes - (totalBytes * marks.lowPercent) / 100;

  const groups = [...Map.groupBy(state.uses, (use) => use.digest)]
    .flatMap(([digest, uses]) => {
      const space = state.spaces.get(digest);

      // Rows that share a digest share one rootfs, which only the last row's removal frees.
      if (space === undefined || space.isShared || !uses.every((use) => isEvictable(state, use))) {
        return [];
      }

      return [
        {
          uses,
          freedBytes: space.freedBytes,
          lastUsedAt: Math.max(...uses.map((use) => use.lastUsedAt)),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.lastUsedAt - right.lastUsedAt ||
        (left.uses[0]?.name ?? '').localeCompare(right.uses[0]?.name ?? ''),
    );

  const picked: ImageUse[] = [];
  let freedBytes = 0;

  for (const group of groups) {
    if (freedBytes >= excessBytes) {
      break;
    }

    picked.push(...group.uses);

    freedBytes += group.freedBytes;
  }

  return picked;
}

// An imp create resolves its image before it writes the imp's row, and a restore or a move
// picks its image well before that, so an image used this recently may be about to gain an imp.
const RECENT_USE_MS = 3_600_000;

function isEvictable(state: Readonly<EvictionState>, use: Readonly<ImageUse>): boolean {
  return (
    use.impCount === 0 &&
    !use.isPinned &&
    !state.keptNames.has(use.name) &&
    state.now - use.lastUsedAt >= RECENT_USE_MS
  );
}
