import type { SignalSource } from '../prompts/read-token';

export function buildStubSignals() {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();

  const signals: SignalSource = {
    on: (signal, listener) => {
      listeners.set(signal, (listeners.get(signal) ?? new Set()).add(listener));
    },
    off: (signal, listener) => {
      listeners.get(signal)?.delete(listener);
    },
  };

  return {
    signals,
    send: (signal: NodeJS.Signals) => {
      for (const listener of listeners.get(signal) ?? []) {
        listener();
      }
    },
    listening: () =>
      [...listeners].filter(([, registered]) => registered.size > 0).map(([signal]) => signal),
  };
}
