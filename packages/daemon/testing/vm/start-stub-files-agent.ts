import type { Socket } from 'node:net';
import type { JsonValue } from '@bufbuild/protobuf';
import {
  FRAME_TYPES,
  RequestSchema,
  decodeAgentMessage,
  decodeJsonPayload,
  encodeJsonFrame,
} from '@impz/agent-protocol';
import type { Request } from '@impz/agent-protocol';
import { FILE_DATA_MAX_BYTES, FILE_SEGMENT_PATTERN } from '@impz/api';
import { startStubAgent } from './start-stub-agent';

interface StubFilesAgentOptions {
  readonly knowsFiles: boolean;

  readonly stack?: Readonly<AsyncDisposableStack>;
}

export async function startStubFilesAgent(
  vsockPath: string,
  options: Readonly<StubFilesAgentOptions>,
) {
  const files = new Map<string, string>();

  const requests: Request[] = [];
  const full = { isFull: false };

  const agent = await startStubAgent(
    vsockPath,
    (socket, frame) => {
      const request = decodeAgentMessage(RequestSchema, decodeJsonPayload(frame));

      requests.push(request);

      if (!options.knowsFiles) {
        sendError(socket, 'UNKNOWN_OP', `unknown op ${request.op}`);

        return;
      }

      const path = request.path ?? '';
      const segments = path.split('/');

      if (
        path.length === 0 ||
        path.length > 512 ||
        segments.length > 8 ||
        !segments.every((segment) => FILE_SEGMENT_PATTERN.test(segment))
      ) {
        sendError(socket, 'BAD_REQUEST', `path ${path} is not allowed`);

        return;
      }

      if (request.op === 'files.remove') {
        sendResponse(socket, { removed: files.delete(path) });

        return;
      }

      const data = request.data ?? new Uint8Array();

      if (data.byteLength > FILE_DATA_MAX_BYTES) {
        sendError(socket, 'BAD_REQUEST', `data is ${data.byteLength} bytes, over the cap`);

        return;
      }

      if (full.isFull) {
        sendError(socket, 'NO_SPACE', 'the read-only files are full');

        return;
      }

      files.set(path, new TextDecoder().decode(data));

      sendResponse(socket, { ok: true });
    },
    { ...(options.stack !== undefined && { stack: options.stack }) },
  );

  return { files, requests, full, close: agent.close };
}

function sendError(socket: Socket, code: string, message: string): void {
  sendResponse(socket, { error: { code, message } });
}

function sendResponse(socket: Socket, value: JsonValue): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}
