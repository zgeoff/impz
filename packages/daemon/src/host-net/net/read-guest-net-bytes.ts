import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GuestNetBytes {
  readonly rxBytes: number;
  readonly txBytes: number;
}

export function readGuestNetBytes(tap: string, sysRoot = '/sys'): GuestNetBytes | null {
  const statistics = join(sysRoot, 'class', 'net', tap, 'statistics');

  try {
    const hostRx = Number(readFileSync(join(statistics, 'rx_bytes'), 'utf8'));
    const hostTx = Number(readFileSync(join(statistics, 'tx_bytes'), 'utf8'));

    // the host's counters on a tap are the other way round: what the host
    // receives on it is what the guest sent
    return { rxBytes: hostTx, txBytes: hostRx };
  } catch {
    return null;
  }
}
