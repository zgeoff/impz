export type StartTimer = (fire: () => void, durationMs: number) => () => void;

// oxlint-disable-next-line zgeoff/module-order -- LONG_CALL_DEADLINES_MS reads it as the module loads
const HOUR_MS = 60 * 60 * 1000;

// These calls answer only when their work ends, which can be later than
// Bun's fetch waits for a silent answer (360 s).
export const LONG_CALL_DEADLINES_MS: ReadonlyMap<string, number> = new Map([
  ['backups.run', 24 * HOUR_MS],
  ['backups.restore', 24 * HOUR_MS],
  ['backups.check', 24 * HOUR_MS],
  ['images.add', 6 * HOUR_MS],
  ['images.build', 6 * HOUR_MS],
  ['system.gc', HOUR_MS],
  ['moves.abort', HOUR_MS],
  ['moves.resume', HOUR_MS],
]);

export interface CallInit {
  readonly redirect?: Request['redirect'];
}

interface LongCall {
  readonly procedure: string;
  readonly deadlineMs: number;
  readonly startTimer: StartTimer;
  readonly send: ((request: Request) => Promise<Response>) | null;
}

export async function sendLongCall(
  request: Request,
  init: Readonly<CallInit>,
  call: Readonly<LongCall>,
): Promise<Response> {
  // One controller for the caller's abort and the deadline, since a browser
  // the SDK serves (Firefox 121–123) has no AbortSignal.any.
  const limit = new AbortController();

  const expired = Promise.withResolvers<never>();

  const onCallerAbort = (): void => {
    limit.abort(request.signal.reason);
  };

  request.signal.addEventListener('abort', onCallerAbort, { once: true });

  if (request.signal.aborted) {
    onCallerAbort();
  }

  const cancel = call.startTimer(() => {
    const error = new DOMException(
      `impd sent no answer to ${call.procedure} in ${formatHours(call.deadlineMs)}`,
      'TimeoutError',
    );

    limit.abort(error);
    expired.reject(error);
  }, call.deadlineMs);

  const signal = limit.signal;

  try {
    const limited = new Request(request, { signal });

    const sent =
      call.send === null ? fetch(limited, { ...init, signal, timeout: false }) : call.send(limited);

    return await Promise.race([sent, expired.promise]);
  } finally {
    cancel();

    request.signal.removeEventListener('abort', onCallerAbort);
  }
}

function formatHours(durationMs: number): string {
  const hours = durationMs / HOUR_MS;

  return hours === 1 ? 'an hour' : `${String(hours)} hours`;
}
