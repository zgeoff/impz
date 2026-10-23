import { listImps, runImp, runInImp, runShellInImp, tryImp } from './imp-cli';
import type { DevInstance } from './instance';
import { instance } from './instance';
import { waitFor } from './wait-for';

export async function waitForExec(name: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`${name} to accept exec`, () => runInImp(name, 'true'), { timeoutMs });
}

export async function holdImp(name: string): Promise<void> {
  await runImp('hold', name, '30m');
}

export async function removeImpsWithPrefix(
  prefix: string,
  target: DevInstance = instance,
): Promise<void> {
  const rows = await listImps(target);

  const stale = rows.map((row) => row.name).filter((name) => name.startsWith(prefix));

  for (const name of stale) {
    await tryImp(['rm', name], { target });
  }
}

export async function writeGuestFile(name: string, path: string, content: string): Promise<void> {
  await runShellInImp(name, `echo ${content} > ${path} && sync`);
}

export function readGuestFile(name: string, path: string): Promise<string> {
  return runShellInImp(name, `cat ${path} 2>/dev/null || echo none`);
}

export function buildPathGoneCheck(path: string): string {
  return `if [ -e '${path}' ]; then echo there; else echo gone; fi`;
}

export async function waitForGuestPathGone(name: string, path: string): Promise<void> {
  await waitFor(`${path} to go`, async () => {
    const state = await runShellInImp(name, buildPathGoneCheck(path));

    if (state !== 'gone') {
      throw new Error(`${path} is still there`);
    }
  });
}

export interface GuestIdentity {
  readonly machineId: string;

  readonly hostKey: string;
}

export async function readGuestIdentity(name: string): Promise<GuestIdentity> {
  const machineId = await readGuestFile(name, '/etc/machine-id');

  const hostKey = await runShellInImp(
    name,
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f2",
  );

  return { machineId, hostKey };
}
