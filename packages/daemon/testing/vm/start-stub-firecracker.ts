import { expect, onTestFinished } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import type { StubGuestMemory } from './stub-guest-memory-schema';

interface StubFirecrackerOptions {
  readonly apiSocket: string;

  readonly logPath: string;

  readonly failures?: readonly string[];

  readonly isLoggingBodies?: boolean;

  readonly memory?: Readonly<StubGuestMemory>;
}

export function buildStubFirecrackerArgv(options: Readonly<StubFirecrackerOptions>): string[] {
  const failures = options.failures ?? [];

  return [
    process.execPath,
    join(import.meta.dir, 'run-stub-firecracker.ts'),
    '--api-sock',
    options.apiSocket,
    options.logPath,
    failures.length === 0 ? 'none' : failures.join(','),
    options.isLoggingBodies === true ? 'bodies' : 'lines',
    options.memory === undefined ? 'none' : JSON.stringify(options.memory),
  ];
}

export async function startStubFirecracker(options: Readonly<StubFirecrackerOptions>) {
  const child = Bun.spawn(buildStubFirecrackerArgv(options), {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  });

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(existsSync(options.apiSocket)).toBeTrue();
  });

  return { pid: child.pid, exited: child.exited };
}
