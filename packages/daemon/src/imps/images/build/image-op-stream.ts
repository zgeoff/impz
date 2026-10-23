import type { Image, ImageBuildPhase, ImageOpEvent } from '@impz/api';
import type { BuildOutput } from './create-build-steps';
import { BUILD_LOG_QUEUE_MAX_BYTES, createLogBudget } from './create-log-budget';

// Bun's fetch gives up after 360 s without a byte and undici's after 300 s (headersTimeout
// before the headers, bodyTimeout between chunks), so a progress event this often keeps a
// client reading.
export const BUILD_KEEPALIVE_MS = 15_000;

export type Repeat = (durationMs: number, tick: () => void) => () => void;

export function runOnInterval(durationMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, durationMs);

  return () => {
    clearInterval(timer);
  };
}

export interface BuildReport {
  readonly setPhase: (phase: ImageBuildPhase) => void;
  readonly output: BuildOutput;
}

export interface ImageOpStreamOptions {
  readonly firstPhase: ImageBuildPhase;

  readonly signal: AbortSignal;

  readonly keepaliveMs: number;
  readonly now: () => number;

  readonly record: (failure: unknown) => void;

  readonly repeat?: Repeat;

  readonly logs?: boolean;
}

type Outcome =
  | { readonly ok: true; readonly image: Image }
  | { readonly ok: false; readonly error: unknown };

export async function* runImageOp(
  run: (signal: AbortSignal, report: BuildReport) => Promise<Image>,
  options: Readonly<ImageOpStreamOptions>,
): AsyncGenerator<ImageOpEvent> {
  const startedAt = options.now();

  const state = {
    phase: options.firstPhase,
    step: null as string | null,
    changed: Promise.withResolvers<void>(),
  };

  const lines: string[] = [];
  const queued = { bytes: 0 };
  const logs = createLogBudget();

  const drainLines = (): string[] => {
    queued.bytes = 0;

    return lines.splice(0);
  };

  const report: BuildReport = {
    setPhase: (phase) => {
      state.phase = phase;

      state.changed.resolve();
    },
    output: {
      emitLog: (line) => {
        if (options.logs !== true || options.signal.aborted) {
          return;
        }

        const bytes = Buffer.byteLength(line);
        const hasRoom = queued.bytes + bytes <= BUILD_LOG_QUEUE_MAX_BYTES;

        for (const text of logs.admit(line, hasRoom)) {
          lines.push(text);

          queued.bytes += Buffer.byteLength(text);
        }

        state.changed.resolve();
      },
      setStep: (step) => {
        state.step = step;

        state.changed.resolve();
      },
    },
  };

  const runToOutcome = async (): Promise<Outcome> => {
    try {
      const image = await run(options.signal, report);

      options.record(null);

      return { ok: true, image };
    } catch (error) {
      options.record(error);

      return { ok: false, error };
    }
  };

  const outcome = runToOutcome();
  const repeat = options.repeat ?? runOnInterval;
  const shown = { phase: state.phase, step: state.step };

  const buildProgress = (): ImageOpEvent => {
    shown.phase = state.phase;
    shown.step = state.step;

    return {
      type: 'progress',
      phase: state.phase,
      elapsedMs: options.now() - startedAt,
      ...(state.step !== null && { step: state.step }),
    };
  };

  yield buildProgress();

  for (;;) {
    const tick = Promise.withResolvers<'tick'>();

    const stopTimer = repeat(options.keepaliveMs, () => {
      tick.resolve('tick');
    });

    const ended = await Promise.race([outcome, tick.promise, state.changed.promise]);

    stopTimer();

    state.changed = Promise.withResolvers<void>();

    for (const text of drainLines()) {
      yield { type: 'log', text };
    }

    if (ended !== 'tick' && ended !== undefined) {
      for (const text of logs.drain()) {
        yield { type: 'log', text };
      }

      if (!ended.ok) {
        throw ended.error;
      }

      yield { type: 'image', image: ended.image };

      return;
    }

    if (ended === 'tick' || shown.phase !== state.phase || shown.step !== state.step) {
      yield buildProgress();
    }
  }
}
