import type { TerminalConnection, TerminalSize } from './terminal-source';

interface Disposable {
  readonly dispose: () => void;
}

export interface TerminalScreen {
  readonly write: (data: Uint8Array) => void;
  readonly onData: (listener: (data: string) => void) => Disposable;
  readonly onResize: (listener: (size: TerminalSize) => void) => Disposable;
}

export function setupTerminalBridge(
  screen: TerminalScreen,
  connection: TerminalConnection,
): () => void {
  const reader = connection.output.getReader();

  const readToScreen = async (): Promise<void> => {
    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          return;
        }

        screen.write(chunk.value);
      }
    } catch {
      // the connection's `ended` promise reports why the output stopped
    }
  };

  const sendKey = async (data: string): Promise<void> => {
    try {
      await connection.write(data);
    } catch {
      // a key after the end goes nowhere; `ended` reports the end
    }
  };

  const stopReading = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // cancel rejects on a stream that already ended
    }
  };

  void readToScreen();

  const listeners = [
    screen.onData((data) => {
      void sendKey(data);
    }),
    screen.onResize((size) => {
      connection.resize(size);
    }),
  ];

  return () => {
    for (const listener of listeners) {
      listener.dispose();
    }

    void stopReading();
  };
}
