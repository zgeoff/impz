export function buildStubHeldAnswer() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<Response>();

  return {
    answer: (): Promise<Response> => {
      arrived.resolve();

      return released.promise;
    },
    arrived: arrived.promise,
    release: (response: Response): void => {
      released.resolve(response);
    },
  };
}
