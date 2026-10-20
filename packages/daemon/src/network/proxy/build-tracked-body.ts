// counts the connection until the body is sent or the client goes away, and
// passes a read error of the source, such as an upstream that closes its
// socket mid-stream, to onReadError
export function buildTrackedBody(
  source: ReadableStream<Uint8Array>,
  release: () => void,
  onReadError: (error: unknown) => void,
) {
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          release();

          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        release();
        onReadError(error);

        // Bun prints the reason a response body errors with to stderr, as an
        // unhandled error dump; with no reason it prints nothing and still
        // resets the client's connection, so the client sees the cut
        controller.error();
      }
    },
    cancel: async (reason) => {
      release();

      await reader.cancel(reason);
    },
  });
}
