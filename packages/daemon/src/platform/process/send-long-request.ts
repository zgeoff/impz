import type { StartTimer } from './clock';
import { startRealTimer } from './start-real-timer';

interface RequestDeadline {
  readonly delayMs: number;
  readonly buildError: () => Error;
}

export interface LongRequestInit {
  readonly method: string;
  readonly redirect?: Request['redirect'];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | ReadableStream<Uint8Array>;
  readonly duplex?: 'half';
  readonly signal?: AbortSignal;
}

export interface LongRequestOptions {
  readonly deadline: RequestDeadline | null;

  readonly startTimer?: StartTimer;

  readonly send?: (request: Request) => Promise<Response>;
}

// Bun's fetch ends an answer that stays silent for 360 s unless the call
// passes `timeout: false`.
export async function sendLongRequest(
  url: string,
  init: LongRequestInit,
  options: Readonly<LongRequestOptions>,
): Promise<Response> {
  const send = options.send ?? ((request: Request) => fetch(request, { timeout: false }));
  const deadline = options.deadline;

  if (deadline === null) {
    return send(new Request(url, init));
  }

  const expiry = new AbortController();

  const expired = Promise.withResolvers<never>();

  const signal =
    init.signal === undefined ? expiry.signal : AbortSignal.any([init.signal, expiry.signal]);

  const startTimer = options.startTimer ?? startRealTimer;

  const cancel = startTimer(() => {
    const error = deadline.buildError();

    expiry.abort(error);
    expired.reject(error);
  }, deadline.delayMs);

  try {
    return await Promise.race([send(new Request(url, { ...init, signal })), expired.promise]);
  } finally {
    cancel();
  }
}
