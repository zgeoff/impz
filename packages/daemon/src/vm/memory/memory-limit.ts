export interface MemoryLimit {
  readonly setGuestMib: (impId: string, guestMib: number) => void;
}

export const NO_MEMORY_LIMIT: MemoryLimit = { setGuestMib: () => {} };
