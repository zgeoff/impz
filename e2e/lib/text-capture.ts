export interface TextCapture {
  readonly read: () => string;

  readonly done: Promise<void>;
}

export function startTextCapture(stream: ReadableStream<Uint8Array>): TextCapture {
  const decoder = new TextDecoder();

  let text = '';

  const done = (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
    }

    text += decoder.decode();
  })();

  return { read: () => text, done };
}
