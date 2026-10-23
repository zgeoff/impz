import type { $, ShellExpression } from 'bun';
import type { DevEnv, DevLayout } from '../lib/build-dev-layout.ts';
import type { DevCheckout } from '../lib/read-dev-checkout.ts';

type DevShell = (
  strings: TemplateStringsArray,
  ...expressions: ShellExpression[]
) => $.ShellPromise;

export interface DevFiles {
  readonly probeFile: (path: string) => boolean;
  readonly probeDirectory: (path: string) => boolean;

  // A file that cannot be read gives null.
  readonly readText: (path: string) => string | null;
  readonly readBytes: (path: string) => Uint8Array;

  // As realpath -m does: the symlinks of the part that exists resolve, and the rest is kept.
  readonly readRealPath: (path: string) => string;

  readonly writeText: (path: string, text: string) => void;
  readonly createDirectory: (path: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export interface DevIO {
  readonly shell: DevShell;

  // Runs a command on the caller's terminal and gives its exit code.
  readonly runAttached: (argv: readonly string[]) => Promise<number>;
  readonly files: DevFiles;
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (text: string) => void;

  // The uid:gid the proxy compiles as, so its binary is the caller's own.
  readonly user: string;
}

export interface Dev {
  readonly env: DevEnv;
  readonly layout: DevLayout;
  readonly checkout: DevCheckout;
  readonly io: DevIO;
}
