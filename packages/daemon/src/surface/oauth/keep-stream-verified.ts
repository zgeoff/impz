import type { StartTimer } from '../../platform/process/clock';

interface StreamCheck {
  // false once the stream's access token no longer passes verify
  readonly probeToken: () => Promise<boolean>;
  readonly everyMs: number;
  readonly startTimer: StartTimer;
}

// An open MCP stream checks its access token again before the token's 15 minutes run out, so a
// revoke or a narrowed approving token that no request of the stream's own carries still ends it.
export function keepStreamVerified(
  body: ReadableStream<Uint8Array>,
  check: Readonly<StreamCheck>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const state = { isEnded: false, cancelTimer: () => {} };

  const stop = () => {
    state.isEnded = true;

    state.cancelTimer();
  };

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const arm = () => {
        state.cancelTimer = check.startTimer(() => {
          void readTokenCheck(check, (isValid) => {
            if (state.isEnded) {
              return;
            }

            if (isValid) {
              arm();

              return;
            }

            stop();

            controller.close();
            void reader.cancel();
          });
        }, check.everyMs);
      };

      arm();
    },
    pull: async (controller) => {
      const chunk = await reader.read().catch((error: unknown) => {
        stop();
        throw error;
      });

      if (chunk.done) {
        stop();

        controller.close();

        return;
      }

      controller.enqueue(chunk.value);
    },
    cancel: async (reason) => {
      stop();

      await reader.cancel(reason);
    },
  });
}

async function readTokenCheck(
  check: Readonly<StreamCheck>,
  then: (isValid: boolean) => void,
): Promise<void> {
  const isValid = await check.probeToken().catch(() => false);

  then(isValid);
}
