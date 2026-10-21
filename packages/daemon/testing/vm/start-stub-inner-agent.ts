import { create, toJson } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  FRAME_TYPES,
  InnerStatusSchema,
  RequestSchema,
  decodeAgentMessage,
  decodeJsonPayload,
  encodeJsonFrame,
} from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

interface StubInnerAgentOptions {
  readonly inner: MessageInitShape<typeof InnerStatusSchema>;

  readonly stack?: Readonly<AsyncDisposableStack>;
}

export function startStubInnerAgent(path: string, options: Readonly<StubInnerAgentOptions>) {
  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const inner = toJson(InnerStatusSchema, create(InnerStatusSchema, options.inner), {
    useProtoFieldName: true,
    alwaysEmitImplicit: true,
  });

  return startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const op = decodeAgentMessage(RequestSchema, decodeJsonPayload(request)).op;

      if (op === 'ping') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            ok: true,
            version: '0.18.0',
            inner,
          }),
        );
      } else if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 0,
            load1: 0,
            sessions: [],
          }),
        );
      } else {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            error: { code: 'UNKNOWN_OP', message: `unknown op ${op}` },
          }),
        );
      }
    },
    closeWith,
  );
}
