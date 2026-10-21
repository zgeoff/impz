import { FRAME_TYPES } from '../../src/vm/agent-client/frame-codec';
import type { StubAgentHandler } from './start-stub-agent';

interface StubExecReplies {
  readonly started: readonly Uint8Array[];

  readonly exited: readonly Uint8Array[];

  readonly onStdin?: (payload: Uint8Array) => void;

  readonly onStdinEnd?: () => void;
}

export function buildStubExecReplies(replies: StubExecReplies): StubAgentHandler {
  return (socket, _request, frames) => {
    const frame = frames.at(-1);

    if (frames.length === 1) {
      for (const reply of replies.started) {
        socket.write(reply);
      }
    } else if (frame?.type === FRAME_TYPES.stdin) {
      replies.onStdin?.(frame.payload);
    } else if (frame?.type === FRAME_TYPES.stdinEof) {
      replies.onStdinEnd?.();

      for (const reply of replies.exited) {
        socket.write(reply);
      }
    }
  };
}
