import { constants } from 'node:os';

export function findSignalNumber(name: string): number | undefined {
  const signals: Readonly<Record<string, number>> = constants.signals;

  return signals[name];
}

export function getSignalName(signal: number): string {
  const entry = Object.entries(constants.signals).find(([, number]) => number === signal);

  return entry?.[0] ?? `SIG${String(signal)}`;
}
