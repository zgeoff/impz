export async function runWithStack<T>(
  body: (stack: Readonly<AsyncDisposableStack>) => Promise<T>,
): Promise<T> {
  const stack = new AsyncDisposableStack();

  // a body that throws before it returns a promise still has its stack released
  const outcome = await Promise.try(body, stack).then(
    (value) => ({ isOk: true as const, value }),
    (error: unknown) => ({ isOk: false as const, error }),
  );

  if (outcome.isOk) {
    await stack.disposeAsync();

    return outcome.value;
  }

  await stack.disposeAsync().catch((releaseError: unknown) => {
    throw new SuppressedError(releaseError, outcome.error, 'the release failed after the body');
  });

  throw outcome.error;
}
