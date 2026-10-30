import { linkSync } from 'node:fs';
import type { DevLockIO } from './create-dev-lock.ts';
import { probeProcessAlive } from './probe-process-alive.ts';
import { readTextOrNull } from './read-text-or-null.ts';
import { removeFile } from './remove-file.ts';
import { writeText } from './write-text.ts';

export function wireDevLockIO(): DevLockIO {
  return {
    pid: process.pid,
    writeText,
    link: linkSync,
    readText: readTextOrNull,
    remove: removeFile,
    probeProcessAlive,
  };
}
