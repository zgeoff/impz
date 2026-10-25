import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { makeOpReader } from '../lib/make-op-reader.ts';
import { probeDirectory } from '../lib/probe-directory.ts';
import { readRealPath } from '../lib/read-real-path.ts';
import { readTextOrNull } from '../lib/read-text-or-null.ts';
import { removeFile } from '../lib/remove-file.ts';
import { runBunShell } from '../lib/run-bun-shell.ts';
import { writeSecretText } from '../lib/write-secret-text.ts';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { writeText } from '../lib/write-text.ts';
import type { DevIO } from './types.ts';

export function wireDevIO(): DevIO {
  return {
    shell: runBunShell,
    runAttached: (argv) =>
      Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited,
    files: {
      probePath: existsSync,
      probeFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
      probeDirectory,
      readText: readTextOrNull,
      readBytes: (path) => readFileSync(path),
      readRealPath: (path) => readRealPath(path, process.cwd()),
      writeText,
      writeSecretText,
      createDirectory: (path) => {
        mkdirSync(path, { recursive: true });
      },
      rename: (from, to) => {
        renameSync(from, to);
      },
      remove: removeFile,
    },
    makeOpReader,
    now: Date.now,
    sleep: Bun.sleep,
    writeStdout: writeStdoutLine,
    writeStderr,
  };
}
