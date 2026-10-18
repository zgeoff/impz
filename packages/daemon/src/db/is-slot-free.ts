import { listTakenSlots } from './list-taken-slots';
import type { ImpQueries } from './open-database';

// whether a warm move may keep `slot`: no imp and no live ticket holds it
export async function isSlotFree(db: ImpQueries, slot: number, now: number): Promise<boolean> {
  const taken = await listTakenSlots(db, now);

  return !taken.has(slot);
}
