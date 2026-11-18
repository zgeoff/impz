import { splitLines } from './split-lines';

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(decodeText()).pipeThrough(splitLines()).getReader();
  const read = { isDone: false };

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) {
        read.isDone = true;

        return;
      }

      yield next.value;
    }
  } finally {
    // A consumer that stops early, or throws, cancels the stream so its source closes too.
    if (!read.isDone) {
      await reader.cancel();
    }

    reader.releaseLock();
  }
}

// TextDecoderStream's writable side takes only ArrayBuffer-backed views, which a Uint8Array over
// any buffer does not satisfy in the DOM types.
function decodeText(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();

  return new TransformStream<Uint8Array, string>({
    transform: (chunk, controller) => {
      controller.enqueue(decoder.decode(chunk, { stream: true }));
    },
    flush: (controller) => {
      const rest = decoder.decode();

      if (rest !== '') {
        controller.enqueue(rest);
      }
    },
  });
}
