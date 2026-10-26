import { openSessionSocket, requireOutput } from './exec-socket';
import type { SessionOutput } from './exec-socket';
import { runInImp } from './imp-cli';
import { runInContainer } from './instance';
import { parseWholeNumber } from './parse-whole-number';
import { waitFor } from './wait-for';

export function parseTemplateKeys(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => /\/templates\/(?<key>[^\/]+)\/meta\.json$/v.exec(line.trim())?.groups?.['key'])
    .filter((key) => key !== undefined);
}

export function checkNoShapeTemplate(memoryMib: number, keys: readonly string[]): void {
  if (keys.length > 0) {
    throw new Error(
      `a boot template of ${String(memoryMib)} MiB is already there (${keys.join(', ')}); a run with --keep leaves one, so remove it first`,
    );
  }
}

export async function readIsnSecret(name: string): Promise<number> {
  const stdout = await runInImp(name, 'isn-probe');

  return parseWholeNumber(stdout, `${name}'s isn-probe`);
}

export async function readMac(name: string): Promise<string> {
  const stdout = await runInImp(name, 'cat', '/sys/class/net/eth0/address');

  return stdout.trim();
}

export async function readSessionOutput(name: string): Promise<SessionOutput> {
  const opened = await openSessionSocket({
    type: 'start',
    name,
    session: 'boot',
    argv: ['sleep', 'infinity'],
    tty: true,
  });

  const output = requireOutput(opened);

  opened.close();

  return output;
}

export async function readShapeTemplateKeys(memoryMib: number): Promise<string[]> {
  const found = await runInContainer([
    'sh',
    '-c',
    `grep -l '"memoryMib": ${String(memoryMib)}' /var/lib/imp/templates/*/meta.json || true`,
  ]);

  return parseTemplateKeys(found.stdout);
}

export async function checkShapeTemplateAbsent(memoryMib: number): Promise<void> {
  const keys = await readShapeTemplateKeys(memoryMib);

  checkNoShapeTemplate(memoryMib, keys);
}

export function waitForShapeTemplate(memoryMib: number): Promise<string> {
  return waitFor(
    `the boot template of ${String(memoryMib)} MiB`,
    async () => {
      const [key] = await readShapeTemplateKeys(memoryMib);

      if (key === undefined) {
        throw new Error('no template yet');
      }

      return key;
    },
    { timeoutMs: 120_000 },
  );
}

export async function removeShapeTemplates(memoryMib: number): Promise<void> {
  const keys = await readShapeTemplateKeys(memoryMib);

  for (const key of keys) {
    await runInContainer(['rm', '-rf', `/var/lib/imp/templates/${key}`]);
  }
}
