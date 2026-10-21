import { UsageError } from '../cli/errors';

const UNIT_MIB: ReadonlyMap<string, number> = new Map([
  ['m', 1],
  ['g', 1024],
  ['t', 1024 * 1024],
]);

export function parseSize(text: string): number {
  const match = /^(?<amount>\d+)(?:(?<unit>[mgt])(?:i?b)?)?$/iu.exec(text.trim());
  const amount = Number(match?.groups?.['amount'] ?? 0);
  const unit = match?.groups?.['unit']?.toLowerCase() ?? 'm';

  if (amount === 0) {
    throw new UsageError(`not a size: ${text} (try 512m, 2g, 1t, or MiB as a whole number)`);
  }

  return amount * (UNIT_MIB.get(unit) ?? 1);
}

export function parseCount(text: string, flag: string): number {
  if (!/^\d+$/u.test(text.trim()) || Number(text) === 0) {
    throw new UsageError(`--${flag} needs a whole number above 0, not ${text}`);
  }

  return Number(text);
}
