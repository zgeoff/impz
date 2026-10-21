import { FRAME_TYPES, encodeFrame, encodeJsonFrame } from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

interface EchoExecScript {
  readonly pid: number;

  readonly stderr: Uint8Array;

  readonly exit: Readonly<{ code: number; signal: number }>;
}

export function startStubEchoExecAgent(
  path: string,
  script: Readonly<EchoExecScript>,
  options: Readonly<{ stack?: Readonly<AsyncDisposableStack> }> = {},
) {
  return startStubAgent(
    path,
    (socket, _request, frames) => {
      const last = frames.at(-1);

      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: script.pid }));
      } else if (last?.type === FRAME_TYPES.stdin) {
        socket.write(encodeFrame(FRAME_TYPES.stdout, last.payload));
      } else if (last?.type === FRAME_TYPES.stdinEof) {
        socket.write(encodeFrame(FRAME_TYPES.stderr, script.stderr));
        socket.end(encodeJsonFrame(FRAME_TYPES.exit, script.exit));
      }
    },
    options,
  );
}
