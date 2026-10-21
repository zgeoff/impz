import {
  FRAME_TYPES,
  PingSchema,
  RequestSchema,
  decodeMessageFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

interface StubAttachReply {
  readonly frame: Uint8Array;
  readonly isEnd: boolean;
}

interface StubAttachAgentOptions {
  readonly bootId: string;

  readonly replies?: readonly StubAttachReply[];

  readonly stack?: Readonly<AsyncDisposableStack>;
}

export async function startStubAttachAgent(
  path: string,
  options: Readonly<StubAttachAgentOptions>,
) {
  const replies = [...(options.replies ?? [])];
  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const parsed = decodeMessageFrame(RequestSchema, request);

      if (parsed.op === 'ping') {
        socket.end(
          encodeMessageFrame(FRAME_TYPES.response, PingSchema, {
            ok: true,
            version: '0.15.0',
            bootId: options.bootId,
          }),
        );

        return;
      }

      const reply = replies.shift();

      if (reply === undefined) {
        socket.end();
      } else if (reply.isEnd) {
        socket.end(reply.frame);
      } else {
        socket.write(reply.frame);
      }
    },
    closeWith,
  );

  return {
    close: agent.close,

    readOps: (): string[] =>
      agent.received.map((frame) => decodeMessageFrame(RequestSchema, frame).op),
  };
}
