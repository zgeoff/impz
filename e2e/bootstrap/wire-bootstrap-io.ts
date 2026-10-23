import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { BootstrapIO } from './types';

export function wireBootstrapIO(): BootstrapIO {
  return {
    // Bun's shell breaks when it is called as a method, with another object as its this.
    shell: (strings, ...expressions) => $(strings, ...expressions),
    probeReadable: (path) => {
      try {
        accessSync(path, constants.R_OK);

        return true;
      } catch {
        return false;
      }
    },
    readText: (path) => readFileSync(path, 'utf8'),
    writeText: (path, text) => {
      writeFileSync(path, text);
    },
    createWorkDirectory: () => mkdtempSync(join(tmpdir(), 'test-bootstrap-')),
    removeDirectory: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    now: Date.now,
    sleep: Bun.sleep,
    writeStdout: (line) => {
      console.log(line);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    exit: (code) => {
      process.exit(code);
    },
  };
}
