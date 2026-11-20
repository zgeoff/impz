export interface OpenGate {
  readonly close: () => void;
  readonly open: () => void;

  // runs the action now, or after the gate opens when it is closed
  readonly pass: (action: () => void) => void;
  readonly wait: () => Promise<void>;
}

export function createOpenGate(): OpenGate {
  const state: { isClosed: boolean; held: (() => void)[] } = { isClosed: false, held: [] };

  const pass = (action: () => void): void => {
    if (state.isClosed) {
      state.held.push(action);
    } else {
      action();
    }
  };

  return {
    close: () => {
      state.isClosed = true;
    },
    open: () => {
      state.isClosed = false;

      const held = state.held;

      state.held = [];

      for (const action of held) {
        action();
      }
    },
    pass,
    wait: () => {
      const opened = Promise.withResolvers<void>();

      pass(opened.resolve);

      return opened.promise;
    },
  };
}
