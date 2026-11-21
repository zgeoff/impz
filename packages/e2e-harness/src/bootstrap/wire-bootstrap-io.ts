import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText } from '@impz/daemon/read-text';
import { runBunShell } from '@impz/scripts/lib/run-bun-shell';
import { writeStderr } from '@impz/scripts/lib/write-stderr';
import { writeStdoutLine } from '@impz/scripts/lib/write-stdout-line';
import { writeText } from '@impz/scripts/lib/write-text';
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
