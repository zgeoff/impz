export type ProxyMode = 'keep' | 'replace';

type ProxyAction = 'reuse' | 'defer' | 'replace';

interface ProxyObservation {
  readonly isRunning: boolean;
  readonly stamp: string;
  readonly storedStamp: string;
  readonly mode: ProxyMode;
}

// A running proxy whose stamp changed stays under 'keep', because a replacement would cut off a
// build or an export in flight.
export function pickProxyAction(proxy: ProxyObservation): ProxyAction {
  if (proxy.isRunning && proxy.stamp === proxy.storedStamp) {
    return 'reuse';
  }

  if (proxy.isRunning && proxy.mode === 'keep') {
    return 'defer';
  }

  return 'replace';
}
