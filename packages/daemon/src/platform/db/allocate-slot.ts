import { listTakenSlots } from './list-taken-slots';
import type { ImpQueries } from './open-database';

// Run it in the same transaction as the insert that takes the slot; the
// unique index on `slot` backs that up.
export async function allocateSlot(
  db: ImpQueries,
  slotCount: number,
  now: number = Date.now(),
): Promise<number> {
  const taken = await listTakenSlots(db, now);

  let slot = 0;

  while (taken.has(slot)) {
    slot += 1;
  }

  if (slot >= slotCount) {
    throw new Error(`every one of the ${String(slotCount)} slots is taken`);
  }

  return slot;
}
