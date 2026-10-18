// counts the connection until the body is sent or the client goes away
export function buildTrackedBody(source: ReadableStream<Uint8Array>, release: () => void) {
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

        controller.error(error);
      }
    },
    cancel: async (reason) => {
      release();

      await reader.cancel(reason);
    },
  });
}
