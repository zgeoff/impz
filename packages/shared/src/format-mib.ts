import { formatBytes } from './format-bytes';

export function formatMib(mib: number): string {
  return formatBytes(mib * 1024 * 1024);
}
