import { listCheckpoints, listImps } from './imp-cli';
import type { ImpRow } from './imp-cli';
import { getSuitePrefix } from './suites';

export interface InventoryEntry {
  readonly name: string;
  readonly id: string;
  readonly image: string;
  readonly slot: number;
  readonly port: number;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly checkpoints: readonly string[];
}

export function buildInventoryEntry(
  row: Readonly<ImpRow>,
  checkpointIds: readonly string[],
): InventoryEntry {
  return {
    name: row.name,
    id: row.id,
    image: row.image,
    slot: row.slot,
    port: row.port,
    vcpus: row.vcpus,
    memoryMib: row.memoryMib,
    checkpoints: checkpointIds.toSorted(),
  };
}

export function collectAwakeRows(rows: readonly Readonly<ImpRow>[]): readonly string[] {
  return rows
    .filter((row) => row.state !== 'sleeping' && row.state !== 'stopped')
    .map((row) => `${row.name} ${row.state}`);
}

export function buildKeptScaleFleet(keptPrefixes: readonly string[], scaleCount: number): string[] {
  const prefix = getSuitePrefix('scale');

  if (!keptPrefixes.includes(prefix)) {
    return [];
  }

  return Array.from(
    { length: scaleCount },
    (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`,
  );
}

export async function readInventory(): Promise<readonly InventoryEntry[]> {
  const rows = await listImps();

  const sorted = rows.toSorted((left, right) => left.name.localeCompare(right.name));

  const checkpoints = await Promise.all(sorted.map((row) => listCheckpoints(row.name)));

  return sorted.map((row, index) =>
    buildInventoryEntry(
      row,
      (checkpoints[index] ?? []).map((checkpoint) => checkpoint.id),
    ),
  );
}

export async function listAwakeImps(): Promise<readonly string[]> {
  const rows = await listImps();

  return collectAwakeRows(rows);
}
