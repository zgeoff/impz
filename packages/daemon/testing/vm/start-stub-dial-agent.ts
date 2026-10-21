import { FRAME_TYPES, encodeFrame, encodeJsonFrame } from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

export function startStubDialAgent(
  path: string,
  answer: (asked: string) => string,
  options: Readonly<{ stack?: Readonly<AsyncDisposableStack> }> = {},
) {
  return startStubAgent(
    path,
    (socket, _request, frames) => {
      const last = frames.at(-1);

      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
      } else if (last?.type === FRAME_TYPES.stdinEof) {
        const asked = frames
          .filter((frame) => frame.type === FRAME_TYPES.stdin)
          .map((frame) => new TextDecoder().decode(frame.payload))
          .join('');

        const reply = new TextEncoder().encode(answer(asked));

        socket.write(encodeFrame(FRAME_TYPES.stdout, reply));
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }
    },
    options,
  );
}
