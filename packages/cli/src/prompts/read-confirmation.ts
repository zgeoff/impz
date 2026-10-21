import { createInterface } from 'node:readline';

interface ConfirmIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

const PROCESS_IO: ConfirmIo = { input: process.stdin, output: process.stderr };

export function readConfirmation(question: string, io: ConfirmIo = PROCESS_IO): Promise<boolean> {
  const answered = Promise.withResolvers<boolean>();
  const lines = createInterface({ input: io.input, terminal: false });

  lines.once('line', (answer) => {
    answered.resolve(['y', 'yes'].includes(answer.trim().toLowerCase()));
    lines.close();
  });

  lines.once('close', () => {
    answered.resolve(false);
  });

  io.output.write(question);

  return answered.promise;
}
