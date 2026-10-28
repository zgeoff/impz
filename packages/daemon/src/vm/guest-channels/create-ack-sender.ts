export interface AckSender {
  readonly countReceived: (bytes: number) => number;
  readonly sendAcks: (waitForDrain: () => Promise<void>) => void;
}

export function createAckSender(
  isOpen: () => boolean,
  sendAck: (bytes: number) => void,
): AckSender {
  const state = { pending: 0, acking: false };

  const runAcks = async (waitForDrain: () => Promise<void>): Promise<void> => {
    state.acking = true;

    while (state.pending > 0 && isOpen()) {
      const bytes = state.pending;

      await waitForDrain();

      state.pending -= bytes;

      if (isOpen()) {
        sendAck(bytes);
      }
    }

    state.acking = false;
  };

  return {
    countReceived: (bytes) => {
      state.pending += bytes;

      return state.pending;
    },
    sendAcks: (waitForDrain) => {
      if (!state.acking) {
        void runAcks(waitForDrain);
      }
    },
  };
}
