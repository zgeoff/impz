import type { Imp } from '@impz/client';
import { formatBytes, formatMib } from '@impz/shared';

const RELATIVE_STEPS = [
  { limit: 60, divisor: 1, unit: 's' },
  { limit: 3600, divisor: 60, unit: 'm' },
  { limit: 86_400, divisor: 3600, unit: 'h' },
  { limit: Number.POSITIVE_INFINITY, divisor: 86_400, unit: 'd' },
] as const;

export function formatRelativeTime(date: Readonly<Date>, nowMs: number): string {
  const seconds = Math.round((nowMs - date.getTime()) / 1000);
  const size = Math.abs(seconds);
  const step = RELATIVE_STEPS.find((candidate) => size < candidate.limit) ?? RELATIVE_STEPS[3];
  const amount = `${String(Math.floor(size / step.divisor))}${step.unit}`;

  return seconds >= 0 ? `${amount} ago` : `in ${amount}`;
}

export function formatCpuUse(imp: Imp): string {
  const percent = imp.resources?.sample?.cpuPercent;
  const used = percent === undefined ? '—' : `${percent.toFixed(0)}%`;
  const limit = imp.cpu?.limit ?? null;

  return limit === null ? used : `${used} / ${String(limit)}`;
}

export function formatDiskUse(imp: Imp): string {
  const size = formatMib(imp.diskMib);
  const usage = imp.diskUsage;

  if (usage === undefined) {
    return `— / ${size}`;
  }

  const bound = usage.isUpperBound ? '≤' : '';
  const partial = usage.isPartial ? '?' : '';

  return `${bound}${formatBytes(usage.exclusiveBytes)}${partial} / ${size}`;
}
