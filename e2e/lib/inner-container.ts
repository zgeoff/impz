import { runInImp, runShellInImp } from './imp-cli';
import { parseWholeNumber } from './parse-whole-number';
import { waitFor } from './wait-for';

export async function readInitStart(name: string): Promise<number> {
  const start = await runShellInImp(name, "cut -d' ' -f22 /proc/1/stat");

  return parseWholeNumber(start, `${name}'s init start`);
}

export async function readUptime(name: string): Promise<number> {
  const uptime = await runShellInImp(name, 'cut -d. -f1 /proc/uptime');

  return parseWholeNumber(uptime, `${name}'s uptime`);
}

export async function waitForInnerInit(name: string): Promise<void> {
  await waitFor(`the inner container in ${name}`, () => runInImp(name, 'true'), {
    timeoutMs: 30_000,
  });
}
