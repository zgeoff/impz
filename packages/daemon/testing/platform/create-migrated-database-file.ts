import { copyFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedTemplate } from './create-migrated-template';

// on disk, not in tmpdir(), which is a tmpfs that holds each file in RAM on
// some hosts
const CACHE_DIRECTORY = join(import.meta.dir, '../../node_modules/.cache/migrated-templates');

export async function createMigratedDatabaseFile(path: string, migration: string): Promise<void> {
  const template = await createMigratedTemplate(CACHE_DIRECTORY, migration, {
    owner: { pid: process.pid, namespace: readPidNamespace() },
    now: Date.now,
    probeProcessRunning,
  });

  copyFileSync(template, path);
}

// the PID namespace tells a run in this sandbox from one in another sandbox
// that shares the folder and reuses the same PIDs
function readPidNamespace(): string {
  return readlinkSync('/proc/self/ns/pid').replaceAll(/\D/gu, '');
}

function probeProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
