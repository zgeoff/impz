import type { DevShell } from '../dev/types.ts';
import type { DevEnv } from '../lib/build-dev-layout.ts';

interface CreateDirectoryOptions {
  // Without parents, a path that exists fails, so a path that appeared since a check is refused.
  readonly parents: boolean;
}

export interface ZfsFiles {
  // A symlink counts, whether or not its target exists.
  readonly probePath: (path: string) => boolean;
  readonly probeDirectory: (path: string) => boolean;

  // A file that cannot be read gives null.
  readonly readText: (path: string) => string | null;

  readonly writeText: (path: string, text: string) => void;
  readonly appendText: (path: string, text: string) => void;

  readonly createDirectory: (path: string, options: CreateDirectoryOptions) => void;
  readonly createTempDirectory: (prefix: string) => string;

  // Fails on a path that exists, a symlink included.
  readonly createEmptyFile: (path: string) => void;

  readonly removeFile: (path: string) => void;

  // A directory that is not empty, or not there, stays as it is.
  readonly removeEmptyDirectory: (path: string) => void;
}

interface ZfsChildOptions {
  readonly cwd: string;
  readonly env: DevEnv;

  // pipe gives the child's stdout and stderr to the caller to read; inherit passes them through.
  readonly output: 'inherit' | 'pipe';
}

export type ZfsSignal = 'SIGINT' | 'SIGTERM';

export interface ZfsChild {
  // The exit code, or 128 plus the signal number for a child that a signal ended.
  readonly exited: Promise<number>;
  readonly kill: (signal: ZfsSignal) => void;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
}

export interface ZfsIO {
  readonly shell: DevShell;
  readonly files: ZfsFiles;
  readonly spawn: (argv: readonly string[], options: ZfsChildOptions) => ZfsChild;
  readonly findBinary: (name: string) => string | null;
  readonly onSignal: (signal: ZfsSignal, handler: () => void) => void;
  readonly now: () => number;
  readonly pid: number;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}
