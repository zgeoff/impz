import { splitLines } from './split-lines';

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).pipeThrough(splitLines()).getReader();

  for (;;) {
    const next = await reader.read();

    if (next.done) {
      return;
    }

    yield next.value;
  }
}
