import { createFrameReader } from '../../src/imp-ops/moves/move-frames';
import {
  MOVE_FINISH_HEADER,
  MOVE_PART_HEADER,
  MOVE_PATHS,
} from '../../src/imp-ops/moves/move-header';
import type { FetchHook } from './create-move-hosts';

export interface MoveFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

export function buildJsonMoveFrame(type: number, value: unknown): MoveFrame {
  return { type, payload: new TextEncoder().encode(JSON.stringify(value)) };
}

// Only the first part goes through `rewrite`, so the whole stream must fit in it, as a
// small imp's does at the default part size; a second part fails the send.
export function makeStubMoveStreamRewrite(
  rewrite: (frames: readonly MoveFrame[]) => readonly MoveFrame[],
): (request: Request, forward: Parameters<FetchHook>[1]) => Promise<Response> {
  return async (request, forward) => {
    const part = request.headers.get(MOVE_PART_HEADER);

    const isPart =
      request.url.endsWith(MOVE_PATHS.receive) && request.headers.get(MOVE_FINISH_HEADER) === null;

    if (!isPart) {
      return forward();
    }

    if (part !== '0') {
      throw new Error(
        `the stream rewrite needs the whole stream in part 0, not part ${String(part)}`,
      );
    }

    const sent = await request.arrayBuffer();
    const frames = await readMoveFrames(new Uint8Array(sent));

    const body = new Blob(rewrite(frames).map((frame) => encodeMoveFrame(frame)));

    return forward(new Request(request.url, { method: 'POST', headers: request.headers, body }));
  };
}

async function readMoveFrames(body: Uint8Array): Promise<MoveFrame[]> {
  const reader = createFrameReader(new Blob([body]).stream());
  const frames: MoveFrame[] = [];

  for (let frame = await reader.readFrame(); frame !== null; frame = await reader.readFrame()) {
    frames.push(frame);
  }

  return frames;
}

function encodeMoveFrame(frame: Readonly<MoveFrame>): Uint8Array {
  const bytes = new Uint8Array(5 + frame.payload.length);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, frame.type);
  view.setUint32(1, frame.payload.length);
  bytes.set(frame.payload, 5);

  return bytes;
}
