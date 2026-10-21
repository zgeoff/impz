export interface StubMoveStreamOptions {
  readonly onEnd?: () => Promise<void>;
  readonly failAtEnd?: Error;
}

export function buildStubMoveStream(
  source: ReadableStream<Uint8Array>,
  options: Readonly<StubMoveStreamOptions> = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const onEnd = options.onEnd ?? (() => Promise.resolve());

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const read = await reader.read();

      if (!read.done) {
        controller.enqueue(read.value);

        return;
      }

      await onEnd();

      if (options.failAtEnd === undefined) {
        controller.close();
      } else {
        controller.error(options.failAtEnd);
      }
    },
  });
}
