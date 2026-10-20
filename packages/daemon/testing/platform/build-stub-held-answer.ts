// An upstream's answer for one request, held until the test releases it, so
// the test can act while the request is under way. `arrived` settles when
// the request comes, and the request gets the response `release` gives.
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
