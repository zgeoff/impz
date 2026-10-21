import type { ImageEvictionConfig } from '../../config';

export function isOverHighMark(
  usage: Readonly<{ usedBytes: number; availableBytes: number }>,
  marks: Readonly<ImageEvictionConfig>,
): boolean {
  return usage.usedBytes * 100 >= marks.highPercent * (usage.usedBytes + usage.availableBytes);
}
