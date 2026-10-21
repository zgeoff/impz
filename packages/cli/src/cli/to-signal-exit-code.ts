import { constants } from 'node:os';

// a shell reports 128 plus the signal's number; impd names a real-time
// signal, which Node does not know, as `SIG<n>`
export function toSignalExitCode(signal: string): number | null {
  const signals: Readonly<Record<string, number>> = constants.signals;
  const numbered = /^SIG(?<number>\d+)$/u.exec(signal)?.groups?.['number'];
  const number = signals[signal] ?? (numbered === undefined ? null : Number(numbered));

  return number === null ? null : 128 + number;
}
