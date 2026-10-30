import { writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { isatty } from 'node:tty';
import type { CliEnv } from '../config/host-store';
import type { ProgressOutput } from '../cp/copy-progress';

export type CommandStdin = Pick<Readable, 'on' | 'off' | 'pause' | 'resume'> & {
  readonly isTTY?: boolean;
  readonly setRawMode?: (mode: boolean) => unknown;
};

export interface CommandIO {
  readonly env: CliEnv;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly writeOut: (chunk: string | Uint8Array) => void;
  readonly writeErr: (chunk: string | Uint8Array) => void;
  readonly isStdinTerminal: boolean;
  readonly isStderrTerminal: boolean;
  readonly readStdin: () => Promise<string>;
  readonly openStdin: () => CommandStdin;
  readonly sleep: (durationMs: number) => Promise<void>;
}

// an open stdin keeps the process alive, so nothing opens it until a command
// asks; raw writes go out whole and at once, so `impz exec` keeps the order
// of stdout and stderr
export function readProcessIO(): CommandIO {
  const encoder = new TextEncoder();

  return {
    env: process.env,
    print: (line) => {
      console.log(line);
    },
    printError: (line) => {
      console.error(line);
    },
    writeOut: (chunk) => {
      writeFully(1, toBytes(encoder, chunk));
    },
    writeErr: (chunk) => {
      writeFully(2, toBytes(encoder, chunk));
    },
    isStdinTerminal: isatty(0),
    isStderrTerminal: isatty(2),
    readStdin: () => Bun.stdin.text(),
    openStdin: () => process.stdin,
    sleep: (durationMs) => Bun.sleep(durationMs),
  };
}

export function toProgressOutput(io: CommandIO): ProgressOutput {
  return { isTTY: io.isStderrTerminal, write: io.writeErr };
}

function toBytes(encoder: TextEncoder, chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
}

// a pipe that is full answers EAGAIN; the write waits for room
function writeFully(fd: number, data: Uint8Array): void {
  let offset = 0;

  while (offset < data.byteLength) {
    try {
      offset += writeSync(fd, data, offset);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EAGAIN')) {
        throw error;
      }

      Bun.sleepSync(1);
    }
  }
}
