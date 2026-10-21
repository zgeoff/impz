import { IMAGE_BUILD_STREAM_TYPE } from '@impz/api';
import type { ImageBuildEvent, ImageBuildPhase } from '@impz/api';
import type { BuildOutput } from './create-build-steps';
import { BUILD_LOG_QUEUE_MAX_BYTES, createLogBudget } from './create-log-budget';

// Bun's fetch gives up after 360 s without a byte and undici's after 300 s (headersTimeout
// before the headers, bodyTimeout between chunks), so a progress line this often keeps a
// client reading.
export const BUILD_KEEPALIVE_MS = 15_000;

export type Repeat = (durationMs: number, tick: () => void) => () => void;

export function runOnInterval(durationMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, durationMs);

  return () => {
    clearInterval(timer);
  };
}

export interface BuildEventStreamDeps {
  readonly keepaliveMs: number;
  readonly now: () => number;

  readonly repeat?: Repeat;
}

export interface BuildReport {
  readonly setPhase: (phase: ImageBuildPhase) => void;
  readonly output: BuildOutput;
}

export function createBuildEventStream(
  clientSignal: AbortSignal,
  run: (signal: AbortSignal, report: BuildReport) => Promise<ImageBuildEvent>,
  deps: Readonly<BuildEventStreamDeps>,
): Response {
  const cancelled = new AbortController();

  const signal = AbortSignal.any([clientSignal, cancelled.signal]);

  const encoder = new TextEncoder();

  const startedAt = deps.now();
  const repeat = deps.repeat ?? runOnInterval;

  const state: {
    phase: ImageBuildPhase;
    step: string | null;
    open: boolean;
    stopKeepalive: () => void;
  } = {
    phase: 'upload',
    step: null,
    open: true,
    stopKeepalive: () => {},
  };

  const stop = (): void => {
    state.open = false;

    state.stopKeepalive();
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        const send = (event: ImageBuildEvent): void => {
          if (!state.open) {
            return;
          }

          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            stop();
          }
        };

        const sendProgress = (): void => {
          send({
            type: 'progress',
            phase: state.phase,
            elapsedMs: deps.now() - startedAt,
            ...(state.step !== null && { step: state.step }),
          });
        };

        const logs = createLogBudget();

        // Bun sends the headers with the first chunk
        sendProgress();

        state.stopKeepalive = repeat(deps.keepaliveMs, sendProgress);

        signal.addEventListener('abort', () => {
          state.stopKeepalive();
        });

        const report: BuildReport = {
          setPhase: (phase) => {
            state.phase = phase;

            sendProgress();
          },
          output: {
            emitLog: (line) => {
              const hasRoom = (controller.desiredSize ?? 0) > 0;

              for (const text of logs.admit(line, hasRoom)) {
                send({ type: 'log', text });
              }
            },
            setStep: (step) => {
              state.step = step;

              sendProgress();
            },
          },
        };

        const sendOutcome = async (): Promise<void> => {
          const outcome = await run(signal, report);

          for (const text of logs.drain()) {
            send({ type: 'log', text });
          }

          send(outcome);

          if (state.open) {
            stop();

            try {
              controller.close();
            } catch {}
          }
        };

        void sendOutcome();
      },
      cancel: () => {
        stop();

        cancelled.abort();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: BUILD_LOG_QUEUE_MAX_BYTES }),
  );

  return new Response(body, { headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE } });
}
