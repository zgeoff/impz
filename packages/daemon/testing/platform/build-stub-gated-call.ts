// Each call waits for the gate to open, then runs the real call, so a test
// holds a lane busy until it has queued the work it means to order.
export function buildStubGatedCall<T>(call: () => Promise<T>) {
  const gate = Promise.withResolvers<undefined>();

  return {
    call: async (): Promise<T> => {
      await gate.promise;

      return call();
    },
    open: (): void => {
      gate.resolve(undefined);
    },
  };
}
