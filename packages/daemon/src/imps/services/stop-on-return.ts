// A generator that waits on a follow's next chunk runs no `finally` until
// one comes, so a reader that stops closes the streams first: their reads
// end, and the generator returns.
export function stopOnReturn<T>(
  generator: Readonly<AsyncGenerator<T, void, undefined>>,
  stop: () => void,
): AsyncIteratorObject<T, void, undefined> {
  const stopIteration = (): Promise<IteratorResult<T, void>> => {
    stop();

    return generator.return();
  };

  const iterator: AsyncIteratorObject<T, void, undefined> = {
    next: () => generator.next(),
    return: stopIteration,
    throw: (error: unknown) => {
      stop();

      return generator.throw(error);
    },
    [Symbol.asyncIterator]: () => iterator,
    [Symbol.asyncDispose]: async () => {
      await stopIteration();
    },
  };

  return iterator;
}
