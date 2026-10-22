import type { ImageEvictionConfig } from '../imps-config';

export function isOverHighMark(
  usage: Readonly<{ usedBytes: number; availableBytes: number }>,
  marks: Readonly<ImageEvictionConfig>,
): boolean {
  return usage.usedBytes * 100 >= marks.highPercent * (usage.usedBytes + usage.availableBytes);
}
