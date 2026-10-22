import type { Bound, Side } from './bound';
import type { Comparison } from './comparison';
import { formatChange } from './format-change';
import { formatSides } from './format-sides';
import { isWithin } from './is-within';

interface CollectBoundChangeOptions {
  readonly name: string;
  readonly narrow: Bound | undefined;
  readonly wide: Bound | undefined;
  readonly side: Side;
  readonly path: string;
  readonly comparison: Comparison;
}

export function collectBoundChange(options: CollectBoundChangeOptions): string[] {
  const narrow = options.narrow;
  const wide = options.wide;
  const side = options.side;

  if (wide === undefined || (narrow !== undefined && isWithin(narrow, wide, side))) {
    return [];
  }

  const change = formatSides(options.comparison, narrow, wide, (bound) => formatBound(bound, side));

  return [formatChange(options.path, `${options.name} ${change}`)];
}

function formatBound(bound: Bound | undefined, side: Side): string {
  if (bound === undefined) {
    return 'none';
  }

  const sign = side === 'lower' ? '>' : '<';

  return `${bound.exclusive ? sign : `${sign}=`} ${String(bound.value)}`;
}
