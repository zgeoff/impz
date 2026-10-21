import { listTakenSlots } from './list-taken-slots';
import type { ImpQueries } from './open-database';

export async function probeSlotFree(db: ImpQueries, slot: number, now: number): Promise<boolean> {
  const taken = await listTakenSlots(db, now);

  return !taken.has(slot);
}
