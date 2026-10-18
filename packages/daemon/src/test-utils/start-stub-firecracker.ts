import { expect, onTestFinished } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import type { StubGuestMemory } from './stub-guest-memory-schema';

interface StubFirecrackerOptions {
  readonly apiSocket: string;

  // where each call is appended, one line each
  readonly logPath: string;

  // prefixes of `METHOD path body` that get Firecracker's 400
  readonly failures?: readonly string[];

  // true: log each call's body after its path
  readonly isLoggingBodies?: boolean;

  // the guest memory a snapshot writes; without it a snapshot writes no files
  readonly memory?: Readonly<StubGuestMemory>;
}

// The command that runs run-stub-firecracker.ts in place of Firecracker,
// for a jail stand-in to hand to startFirecracker. Its argv names the API
// socket, as the liveness check of a Firecracker expects.
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

// Starts the stand-in as a process of its own, like a VM impd adopts, and
// waits for its API socket; the process is killed when the test ends.
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
