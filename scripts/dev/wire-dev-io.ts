import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { $ } from 'bun';
import { readRealPath } from '../lib/read-real-path.ts';
import type { DevIO } from './types.ts';

export function wireDevIO(): DevIO {
  return {
    // Bun's shell breaks when it is called as a method, with another object as its this.
    shell: (strings, ...expressions) => $(strings, ...expressions),
    runAttached: (argv) =>
      Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited,
    files: {
      probeFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
      probeDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
      readText: (path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      },
      readBytes: (path) => readFileSync(path),
      readRealPath: (path) => readRealPath(path, process.cwd()),
      writeText: (path, text) => {
        writeFileSync(path, text);
      },
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
