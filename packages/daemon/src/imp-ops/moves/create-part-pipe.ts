import type { Clock } from '../../platform/process/clock';
import { REAL_CLOCK } from '../../platform/process/real-clock';

export const MOVE_PART_BYTES = 256 * 1024 * 1024;
export const PART_WAIT_MS = 60_000;

export interface PartPipe {
  readonly stream: ReadableStream<Uint8Array>;
  readonly push: (body: ReadableStream<Uint8Array>) => Promise<void>;
  readonly end: () => void;
  readonly fail: (error: Error) => void;
}

interface Part {
  readonly read: () => Promise<{
    readonly done?: boolean | undefined;
    readonly value?: Uint8Array | undefined;
  }>;
  readonly cancel: () => Promise<void>;
  readonly consumed: PromiseWithResolvers<void>;
}

export function createPartPipe(
  waitMs = PART_WAIT_MS,
  timer: Pick<Clock, 'now' | 'startTimer'> = REAL_CLOCK,
): PartPipe {
  const parts: Part[] = [];

  const state: {
    isEnded: boolean;
    error: Error | null;
    waiter: PromiseWithResolvers<void> | null;
  } = {
    isEnded: false,
    error: null,
    waiter: null,
  };

  const wake = (): void => {
    state.waiter?.resolve();
    state.waiter = null;
  };

  const waitForPart = async (): Promise<Part | null> => {
    const deadline = timer.now() + waitMs;

    while (parts.length === 0) {
      if (state.error !== null) {
        throw state.error;
      }

      if (state.isEnded) {
        return null;
      }

      if (timer.now() > deadline) {
        throw new Error('the next part of the move stream did not come');
      }

      const waiter = Promise.withResolvers<void>();

      state.waiter = waiter;

      const cancel = timer.startTimer(
        () => {
          waiter.resolve();
        },
        Math.max(0, deadline - timer.now()),
      );

      await waiter.promise;

      cancel();
    }

    return parts[0] ?? null;
  };

  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      for (;;) {
        const part = await waitForPart();

        if (part === null) {
          controller.close();

          return;
        }

        const next = await part.read();

        if (next.done !== true && next.value !== undefined) {
          controller.enqueue(next.value);

          return;
        }

        parts.shift();
        part.consumed.resolve();
      }
    },
  });

  return {
    stream,
    push: (body) => {
      if (state.error !== null) {
        return Promise.reject(state.error);
      }

      const reader = body.getReader();

      const part: Part = {
        read: () => reader.read(),
        cancel: () => reader.cancel(),
        consumed: Promise.withResolvers<void>(),
      };

      parts.push(part);

      wake();

      return part.consumed.promise;
    },
    end: () => {
      state.isEnded = true;

      wake();
    },
    fail: (error) => {
      state.error = error;

      for (const part of parts.splice(0)) {
        part.consumed.reject(error);
        void part.cancel();
      }

      wake();
    },
  };
}

interface ChunkSource {
  readonly readNext: () => Promise<Uint8Array | null>;
  readonly putBack: (chunk: Uint8Array) => void;
  readonly isDone: () => boolean;
}

function createChunkSource(
  frames: Readonly<AsyncGenerator<Uint8Array, void, undefined>>,
): ChunkSource {
  const state: { pending: Uint8Array | null; isDone: boolean } = { pending: null, isDone: false };

  return {
    readNext: async () => {
      if (state.pending !== null) {
        const pending = state.pending;

        state.pending = null;

        return pending;
      }

      const next = await frames.next();

      if (next.done === true) {
        state.isDone = true;

        return null;
      }

      return next.value;
    },
    putBack: (chunk) => {
      state.pending = chunk;
    },
    isDone: () => state.isDone && state.pending === null,
  };
}

export async function sendInParts(
  frames: Readonly<AsyncGenerator<Uint8Array, void, undefined>>,
  post: (part: number, body: ReadableStream<Uint8Array>) => Promise<void>,
  partBytes = MOVE_PART_BYTES,
): Promise<number> {
  try {
    return await sendEachPart(createChunkSource(frames), post, partBytes);
  } finally {
    // A failed post leaves the frames part-read, and only returning the
    // generator closes their files.
    await frames.return();
  }
}

async function sendEachPart(
  source: ChunkSource,
  post: (part: number, body: ReadableStream<Uint8Array>) => Promise<void>,
  partBytes: number,
): Promise<number> {
  let part = 0;

  while (!source.isDone()) {
    let sent = 0;

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = sent < partBytes ? await source.readNext() : null;

        if (chunk === null) {
          controller.close();

          return;
        }

        const room = partBytes - sent;

        if (chunk.length > room) {
          source.putBack(chunk.subarray(room));
          controller.enqueue(chunk.subarray(0, room));

          sent = partBytes;

          return;
        }

        sent += chunk.length;

        controller.enqueue(chunk);
      },
    });

    await post(part, body);

    part += 1;

    const next = source.isDone() ? null : await source.readNext();

    if (next !== null) {
      source.putBack(next);
    }
  }

  return part;
}
