import { requireImp, runShellInImp } from './imp-cli';
import { parseWholeNumber } from './parse-whole-number';

async function readMeminfoKib(name: string, field: string): Promise<number> {
  const stdout = await runShellInImp(
    name,
    `grep '^${field}:' /proc/meminfo | tr -s ' ' | cut -d' ' -f2`,
  );

  return parseWholeNumber(stdout, `${name}'s ${field}`);
}

export async function readMemTotalMib(name: string): Promise<number> {
  return Math.round((await readMeminfoKib(name, 'MemTotal')) / 1024);
}

export async function readMemAvailableMib(name: string): Promise<number> {
  return Math.floor((await readMeminfoKib(name, 'MemAvailable')) / 1024);
}

export async function readPluggedMib(name: string): Promise<number> {
  const row = await requireImp(name);

  if (row.pluggedMib === undefined) {
    throw new Error(`${name} reports no pluggedMib`);
  }

  return row.pluggedMib;
}
