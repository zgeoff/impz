import { setupLogging } from '@impz/daemon/host/platform/process/setup-logging';
import { resetSync } from '@logtape/logtape';

const listeners = new Set<(line: string) => void>();

export function startImpdLogCapture(onLine: (line: string) => void): () => void {
  if (listeners.size === 0) {
    setupLogging((line) => {
      for (const listener of listeners) {
        listener(line.replace(/\n$/v, ''));
      }
    });
  }

  listeners.add(onLine);

  return () => {
    if (listeners.delete(onLine) && listeners.size === 0) {
      resetSync();
    }
  };
}
