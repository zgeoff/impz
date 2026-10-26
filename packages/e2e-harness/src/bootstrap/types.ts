import type { $, ShellExpression } from 'bun';
import type { Distro } from './distros';
import type { BootstrapArgs } from './parse-bootstrap-args';

type BootstrapShell = (
  strings: TemplateStringsArray,
  ...expressions: ShellExpression[]
) => $.ShellPromise;

export interface BootstrapIO {
  readonly shell: BootstrapShell;
  readonly probeReadable: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly writeText: (path: string, text: string) => void;
  readonly createWorkDirectory: () => string;
  readonly removeDirectory: (path: string) => void;
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
}

interface BootstrapState {
  container: string | null;
}

export interface BootstrapRun {
  readonly io: BootstrapIO;
  readonly root: string;
  readonly args: BootstrapArgs;
  readonly image: string;
  readonly work: string;
  readonly fakeKey: string;
  readonly runID: number;
  readonly zfsPool: string;
  readonly state: BootstrapState;
  readonly log: (line: string) => void;
}

export interface BootstrapTarget {
  readonly distro: Distro;
  readonly storage: readonly string[];
  readonly health: boolean;
}
