import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  ActivitySchema,
  ErrorResponseSchema,
  FRAME_TYPES,
  PingSchema,
  RequestSchema,
  decodeMessageFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import type { InnerStatusSchema } from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

interface StubInnerAgentOptions {
  readonly inner: MessageInitShape<typeof InnerStatusSchema>;

  readonly stack?: Readonly<AsyncDisposableStack>;
}

export function startStubInnerAgent(path: string, options: Readonly<StubInnerAgentOptions>) {
  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  return startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const op = decodeMessageFrame(RequestSchema, request).op;

      if (op === 'ping') {
        socket.end(
          encodeMessageFrame(FRAME_TYPES.response, PingSchema, {
            ok: true,
            version: '0.18.0',
            inner: options.inner,
          }),
        );
      } else if (op === 'activity') {
        socket.end(encodeMessageFrame(FRAME_TYPES.response, ActivitySchema, {}));
      } else {
        socket.end(
          encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
            error: { code: 'UNKNOWN_OP', message: `unknown op ${op}` },
          }),
        );
      }
    },
    closeWith,
  );
}
