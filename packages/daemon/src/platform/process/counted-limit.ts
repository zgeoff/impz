export interface CountedLimit {
  readonly max: number;

  readonly tryClaim: (key: string) => (() => void) | null;

  readonly countHeld: (key: string) => number;
  readonly isFull: (key: string) => boolean;
}

export function createCountedLimit(max: number): CountedLimit {
  const held = new Map<string, number>();

  const countHeld = (key: string): number => held.get(key) ?? 0;

  return {
    max,
    tryClaim: (key) => {
      const count = countHeld(key);

      if (count >= max) {
        return null;
      }

      held.set(key, count + 1);

      let isReleased = false;

      return () => {
        if (isReleased) {
          return;
        }

        isReleased = true;

        const left = countHeld(key) - 1;

        if (left <= 0) {
          held.delete(key);
        } else {
          held.set(key, left);
        }
      };
    },
    countHeld,
    isFull: (key) => countHeld(key) >= max,
  };
}
