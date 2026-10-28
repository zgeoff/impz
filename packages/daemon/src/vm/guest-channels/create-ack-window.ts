export interface AckWindow {
  readonly countSent: (bytes: number) => void;
  readonly countAcked: (bytes: number) => void;
  readonly waitForRoom: () => Promise<void>;
  readonly stop: () => void;
}

export function createAckWindow(windowBytes: number, isOpen: () => boolean): AckWindow {
  const state: { unacked: number; waiter: (() => void) | null } = { unacked: 0, waiter: null };

  return {
    countSent: (bytes) => {
      state.unacked += bytes;
    },
    countAcked: (bytes) => {
      state.unacked = Math.max(0, state.unacked - bytes);
      state.waiter?.();
    },
    waitForRoom: async () => {
      while (isOpen() && state.unacked > windowBytes) {
        const room = Promise.withResolvers<void>();

        state.waiter = room.resolve;

        await room.promise;

        state.waiter = null;
      }
    },
    stop: () => {
      state.waiter?.();
    },
  };
}
