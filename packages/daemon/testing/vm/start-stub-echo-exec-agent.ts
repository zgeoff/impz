import {
  ExitSchema,
  FRAME_TYPES,
  StartedSchema,
  encodeFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
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
        socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: script.pid }));
      } else if (last?.type === FRAME_TYPES.stdin) {
        socket.write(encodeFrame(FRAME_TYPES.stdout, last.payload));
      } else if (last?.type === FRAME_TYPES.stdinEof) {
        socket.write(encodeFrame(FRAME_TYPES.stderr, script.stderr));
        socket.end(encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, script.exit));
      }
    },
    options,
  );
}
