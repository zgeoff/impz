import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { $ } from 'bun';
import { toProcessEnv } from '../lib/to-process-env.ts';
import type { ZfsChild, ZfsIO } from './types.ts';

export function wireZfsIO(): ZfsIO {
  return {
    // Bun's shell breaks when it is called as a method, with another object as its this.
    shell: (strings, ...expressions) => $(strings, ...expressions),
    files: {
      probePath: (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
      probeDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
      readText: (path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      },
      writeText: (path, text) => {
        writeFileSync(path, text);
      },
      appendText: (path, text) => {
        appendFileSync(path, text);
      },
      createDirectory: (path, options) => {
        mkdirSync(path, { recursive: options.parents });
      },
      createTempDirectory: (prefix) => mkdtempSync(prefix),
      createEmptyFile: (path) => {
        closeSync(openSync(path, 'wx'));
      },
      removeFile: (path) => {
        rmSync(path, { force: true });
      },
      removeEmptyDirectory: (path) => {
        try {
          rmdirSync(path);
        } catch {
          // a directory that holds files, or is gone, stays as it is
        }
      },
    },
    spawn: (argv, options) => {
      const output = options.output;

      const child = Bun.spawn([...argv], {
        cwd: options.cwd,
        env: toProcessEnv(options.env),
        stdin: 'inherit',
        stdout: output,
        stderr: output,
      });

      const wired: ZfsChild = {
        exited: child.exited,
        kill: (signal) => {
          child.kill(signal);
        },
        stdout: child.stdout instanceof ReadableStream ? child.stdout : null,
        stderr: child.stderr instanceof ReadableStream ? child.stderr : null,
      };

      return wired;
    },
    findBinary: (name) => Bun.which(name),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    now: Date.now,
    pid: process.pid,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  };
}
