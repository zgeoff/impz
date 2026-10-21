interface TextReader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: string | undefined }>;
}

// The read still pending when this returns takes the stream's next chunk, so the caller
// cannot use the reader again.
export async function readQueuedText(reader: TextReader, quietMs: number): Promise<string> {
  const parts: string[] = [];

  for (;;) {
    const quiet = Promise.withResolvers<null>();

    const timer = setTimeout(() => {
      quiet.resolve(null);
    }, quietMs);

    const chunk = await Promise.race([reader.read(), quiet.promise]);

    clearTimeout(timer);

    if (chunk === null || chunk.done) {
      return parts.join('');
    }

    parts.push(chunk.value ?? '');
  }
}
