import type { ImpQueries } from './open-database';

// The lowest slot no imp or ticket holds. Run it in the same transaction as
// the insert that takes the slot; the unique index on `slot` backs that up.
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

// whether a warm move may keep `slot`: no imp and no live ticket holds it
export async function isSlotFree(db: ImpQueries, slot: number, now: number): Promise<boolean> {
  const taken = await listTakenSlots(db, now);

  return !taken.has(slot);
}

// The slots imps hold, and those that a warm move's live ticket keeps for
// the imp it brings (docs/architecture/storage/moves.md#warm-moves): until the
// commit, once its stream started, else until the stream's start window ends
async function listTakenSlots(db: ImpQueries, now: number): Promise<Set<number>> {
  const imps = await db.selectFrom('imps').select('slot').execute();

  const held = await db
    .selectFrom('move_tickets')
    .select('slot')
    .where('slot', 'is not', null)
    .where('committed_at', 'is', null)
    .where((row) => row.or([row('stream_used_at', 'is not', null), row('stream_by', '>', now)]))
    .execute();

  return new Set([...imps.map((row) => row.slot), ...held.flatMap((row) => row.slot ?? [])]);
}
