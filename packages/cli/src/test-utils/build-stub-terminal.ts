import { PassThrough } from 'node:stream';

export function buildStubTerminal() {
  const modes: boolean[] = [];

  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (raw: boolean) => {
      modes.push(raw);
    },
  });

  return { stdin, modes };
}
