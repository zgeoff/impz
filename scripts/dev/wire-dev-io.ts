import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { $ } from 'bun';
import { makeOpReader } from '../lib/make-op-reader.ts';
import { readRealPath } from '../lib/read-real-path.ts';
import { readTextOrNull } from '../lib/read-text-or-null.ts';
import { writeSecretText } from '../lib/write-secret-text.ts';
import type { DevIO } from './types.ts';

export function wireDevIO(): DevIO {
  return {
    // Bun's shell breaks when it is called as a method, with another object as its this.
    shell: (strings, ...expressions) => $(strings, ...expressions),
    runAttached: (argv) =>
      Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited,
    files: {
      probePath: existsSync,
      probeFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
      probeDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
      readText: readTextOrNull,
      readBytes: (path) => readFileSync(path),
      readRealPath: (path) => readRealPath(path, process.cwd()),
      writeText: (path, text) => {
        writeFileSync(path, text);
      },
      writeSecretText,
      createDirectory: (path) => {
        mkdirSync(path, { recursive: true });
      },
      rename: (from, to) => {
        renameSync(from, to);
      },
      remove: (path) => {
        rmSync(path, { force: true });
      },
    },
    makeOpReader,
    now: Date.now,
    sleep: Bun.sleep,
    writeStdout: (line) => {
      console.log(line);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    user: `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
  };
}
