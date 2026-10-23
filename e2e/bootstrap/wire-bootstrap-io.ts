import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText } from '../../scripts/lib/read-text.ts';
import { runBunShell } from '../../scripts/lib/run-bun-shell.ts';
import { writeStderr } from '../../scripts/lib/write-stderr.ts';
import { writeStdoutLine } from '../../scripts/lib/write-stdout-line.ts';
import { writeText } from '../../scripts/lib/write-text.ts';
import type { BootstrapIO } from './types';

export function wireBootstrapIO(): BootstrapIO {
  return {
    shell: runBunShell,
    probeReadable: (path) => {
      try {
        accessSync(path, constants.R_OK);

        return true;
      } catch {
        return false;
      }
    },
    readText,
    writeText,
    createWorkDirectory: () => mkdtempSync(join(tmpdir(), 'test-bootstrap-')),
    removeDirectory: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    now: Date.now,
    sleep: Bun.sleep,
    writeStdout: writeStdoutLine,
    writeStderr,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
  };
}
