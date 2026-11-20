import { readlinkSync } from 'node:fs';

export interface RunOwner {
  readonly pid: number;
  readonly namespace: string;
}

// the PID namespace tells a run in this sandbox from one in another sandbox
// that shares the folder and reuses the same PIDs
export function readRunOwner(): RunOwner {
  return {
    pid: process.pid,
    namespace: readlinkSync('/proc/self/ns/pid').replaceAll(/\D/gu, ''),
  };
}
