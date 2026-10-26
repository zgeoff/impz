import type { $, ShellExpression } from 'bun';
import type { DevEnv, DevLayout } from '../lib/build-dev-layout.ts';
import type { OpReader } from '../lib/make-op-reader.ts';
import type { DevCheckout } from '../lib/read-dev-checkout.ts';

export type DevShell = (
  strings: TemplateStringsArray,
  ...expressions: ShellExpression[]
) => $.ShellPromise;

interface DevFiles {
  // A device node such as /dev/kvm counts.
  readonly probePath: (path: string) => boolean;
  readonly probeFile: (path: string) => boolean;
  readonly probeDirectory: (path: string) => boolean;
  readonly readText: (path: string) => string | null;

  // As realpath -m does: the symlinks of the part that exists resolve, and the rest is kept.
  readonly readRealPath: (path: string) => string;

  readonly writeText: (path: string, text: string) => void;
  readonly writeSecretText: (path: string, text: string) => void;
  readonly createDirectory: (path: string) => void;
  readonly remove: (path: string) => void;
}

export interface DevIO {
  readonly shell: DevShell;
  readonly runAttached: (argv: readonly string[]) => Promise<number>;
  readonly files: DevFiles;
  readonly makeOpReader: (env: DevEnv) => OpReader | null;
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (text: string) => void;
}

export interface Dev {
  readonly env: DevEnv;
  readonly layout: DevLayout;
  readonly checkout: DevCheckout;
  readonly io: DevIO;
}
