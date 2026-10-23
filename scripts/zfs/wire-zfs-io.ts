import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
} from 'node:fs';
import { probeDirectory } from '../lib/probe-directory.ts';
import { readTextOrNull } from '../lib/read-text-or-null.ts';
import { removeFile } from '../lib/remove-file.ts';
import { runBunShell } from '../lib/run-bun-shell.ts';
import { toProcessEnv } from '../lib/to-process-env.ts';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeText } from '../lib/write-text.ts';
import type { ZfsChild, ZfsIO } from './types.ts';

export function wireZfsIO(): ZfsIO {
  return {
    shell: runBunShell,
    files: {
      probePath: (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
      probeDirectory,
      readText: readTextOrNull,
      writeText,
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
      removeFile,
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
    writeStderr,
  };
}
