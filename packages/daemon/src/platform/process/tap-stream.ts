export type StreamEnd =
  | { readonly kind: 'done' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'error'; readonly error: unknown };

interface StreamTap {
  readonly onChunk?: (chunk: Uint8Array) => void;
  readonly onEnd: (end: StreamEnd) => void;
}

export function tapStream(
  body: ReadableStream<Uint8Array>,
  tap: Readonly<StreamTap>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const state = { ended: false };

  const end = (streamEnd: StreamEnd): void => {
    if (!state.ended) {
      state.ended = true;

      tap.onEnd(streamEnd);
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        try {
          const chunk = await reader.read();

          if (chunk.done) {
            end({ kind: 'done' });

            controller.close();

            return;
          }

          tap.onChunk?.(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          end({ kind: 'error', error });

          // Bun prints the reason a response body errors with to stderr, as an
          // unhandled error dump; with no reason it prints nothing and still
          // resets the client's connection, so the client sees the cut
          controller.error();
        }
      },
      cancel: async (reason) => {
        end({ kind: 'cancel' });

        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
