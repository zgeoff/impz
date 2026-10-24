export interface TeedResponse {
  readonly response: Response;
  readonly firstChunk: Promise<Error | null>;
}

export function teeFirstChunk(response: Response): TeedResponse {
  if (response.body === null) {
    return { response, firstChunk: Promise.resolve(new Error('the response has no body')) };
  }

  const [forPage, forSignal] = response.body.tee();

  return {
    response: new Response(forPage, response),
    firstChunk: readFirstChunk(forSignal.getReader()),
  };
}

async function readFirstChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Error | null> {
  try {
    const first = await reader.read();

    // a branch of a tee resolves its cancel only once the other branch cancels too
    void reader.cancel();

    return first.done ? new Error('the stream ended before its first chunk') : null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
