import type { TerminalScreen } from '../components/console/setup-terminal-bridge';
import type { TerminalSize } from '../components/console/terminal-source';

export function buildStubTerminalScreen() {
  const written: string[] = [];
  const disposed: string[] = [];
  const listeners: { data?: (data: string) => void; resize?: (size: TerminalSize) => void } = {};

  const screen: TerminalScreen = {
    write: (data) => {
      written.push(new TextDecoder().decode(data));
    },
    onData: (listener) => {
      listeners.data = listener;

      return {
        dispose: () => {
          delete listeners.data;
          disposed.push('data');
        },
      };
    },
    onResize: (listener) => {
      listeners.resize = listener;

      return {
        dispose: () => {
          delete listeners.resize;
          disposed.push('resize');
        },
      };
    },
  };

  const emitKeys = (data: string): void => {
    if (listeners.data === undefined) {
      throw new Error('nothing listens for keys');
    }

    listeners.data(data);
  };

  const emitResize = (size: TerminalSize): void => {
    if (listeners.resize === undefined) {
      throw new Error('nothing listens for sizes');
    }

    listeners.resize(size);
  };

  return { screen, written, disposed, emitKeys, emitResize };
}
