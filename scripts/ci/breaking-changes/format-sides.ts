import type { Comparison } from './comparison';

export function formatSides<T>(
  comparison: Comparison,
  narrow: T,
  wide: T,
  format: (value: T) => string,
): string {
  const [before, after] = comparison.direction === 'toServer' ? [narrow, wide] : [wide, narrow];

  return `${format(before)} → ${format(after)}`;
}
