export class SlotTakenError extends Error {
  override name = 'SlotTakenError';

  constructor(slot: number) {
    super(`slot ${String(slot)} is taken on this host`);
  }
}
