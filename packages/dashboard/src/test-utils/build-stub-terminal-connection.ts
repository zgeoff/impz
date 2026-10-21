import type { TerminalConnection, TerminalSize } from '../components/console/terminal-source';

interface StubTerminalConnectionOptions {
  readonly write?: (data: string) => Promise<void>;
}

export function buildStubTerminalConnection(options: StubTerminalConnectionOptions = {}) {
  const output = new TransformStream<Uint8Array, Uint8Array>();

  const sent: string[] = [];
  const sizes: TerminalSize[] = [];

  const connection: TerminalConnection = {
    output: output.readable,
    write:
      options.write ??
      ((data) => {
        sent.push(data);

        return Promise.resolve();
      }),
    resize: (size) => {
      sizes.push(size);
    },
    close: () => {},
    ended: new Promise(() => {}),
  };

  return { connection, output: output.writable.getWriter(), sent, sizes };
}
