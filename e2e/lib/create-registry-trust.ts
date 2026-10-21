import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { runCommand } from './instance';

export const OWNER_FILE = 'imp-e2e-owner';
const OwnerSchema = z.object({ pid: z.int(), startTime: z.string() });

export interface RegistryTrustOptions {
  readonly registry: string;

  readonly certPath: string;

  // Docker reads these directories on each request.
  readonly certsRoot?: string;

  readonly asRoot?: readonly string[];

  readonly procRoot?: string;
}

export interface RegistryTrust {
  readonly directory: string;

  readonly remove: () => Promise<void>;
}

export async function createRegistryTrust(
  options: Readonly<RegistryTrustOptions>,
): Promise<RegistryTrust> {
  const certsRoot = options.certsRoot ?? '/etc/docker/certs.d';
  const asRoot = options.asRoot ?? ['sudo', '--non-interactive'];
  const procRoot = options.procRoot ?? '/proc';
  const directory = join(certsRoot, options.registry);
  const startTime = readStartTime(procRoot, process.pid);

  // A directory whose owner cannot be proven later is one no run may remove.
  if (startTime === null) {
    throw new Error(
      `refusing to trust ${options.registry}: this process's start time is unreadable`,
    );
  }

  const host = options.registry.slice(0, options.registry.lastIndexOf(':'));

  await removeStaleRegistryTrusts({ name: host, certsRoot, asRoot, procRoot });
  await runAs(asRoot, ['mkdir', '--parents', certsRoot]);

  // No --parents: mkdir fails on a directory that is already there, so the
  // check and the claim are one step.
  const made = await runCommand([...asRoot, 'mkdir', directory]);

  if (made.exitCode !== 0) {
    throw new Error(`refusing to trust ${options.registry}: ${made.stderr.trim()}`);
  }

  let isRemoved = false;

  const remove = async () => {
    if (isRemoved) {
      return;
    }

    isRemoved = true;

    await runAs(asRoot, ['rm', '--recursive', '--force', directory]);
  };

  const owner = JSON.stringify({ pid: process.pid, startTime });

  try {
    await runAs(asRoot, ['tee', join(directory, OWNER_FILE)], owner);
    await runAs(asRoot, ['cp', options.certPath, join(directory, 'ca.crt')]);
  } catch (error) {
    await remove();

    throw error;
  }

  return { directory, remove };
}

// The start time in clock ticks since boot (field 22 of the stat) tells a
// reused pid apart.
function readStartTime(procRoot: string, pid: number): string | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');

    // The command name may hold spaces, so the fields start past the last ')'.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

async function runAs(
  asRoot: readonly string[],
  argv: readonly string[],
  stdin?: string,
): Promise<void> {
  const input = stdin === undefined ? {} : { stdin };

  const result = await runCommand([...asRoot, ...argv], input);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

function readOwner(directory: string): z.infer<typeof OwnerSchema> | null {
  try {
    const text = readFileSync(join(directory, OWNER_FILE), 'utf8');
    const parsed = OwnerSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface StaleTrustOptions {
  readonly name: string;
  readonly certsRoot?: string;
  readonly asRoot?: readonly string[];
  readonly procRoot?: string;
}

export async function removeStaleRegistryTrusts(
  options: Readonly<StaleTrustOptions>,
): Promise<readonly string[]> {
  const certsRoot = options.certsRoot ?? '/etc/docker/certs.d';
  const asRoot = options.asRoot ?? ['sudo', '--non-interactive'];
  const procRoot = options.procRoot ?? '/proc';
  const removed: string[] = [];
  let entries: readonly string[] = [];

  try {
    entries = readdirSync(certsRoot);
  } catch {
    return removed;
  }

  for (const entry of entries.filter((name) => name.startsWith(`${options.name}:`))) {
    const directory = join(certsRoot, entry);
    const owner = readOwner(directory);

    if (owner !== null && readStartTime(procRoot, owner.pid) !== owner.startTime) {
      await runAs(asRoot, ['rm', '--recursive', '--force', directory]);

      removed.push(directory);
    }
  }

  return removed;
}
