import { mergeBytes } from '@impz/shared';

// Dropping the middle loses the least: a build's first error is near the
// head, its summary near the tail.
export interface CappedOutput {
  readonly head: Uint8Array;
  readonly tail: Uint8Array;
  readonly droppedBytes: number;
}

export interface OutputCollector {
  readonly push: (chunk: Uint8Array) => void;
  readonly finish: () => CappedOutput;
}

export function createOutputCollector(maxBytes: number, headBytes: number): OutputCollector {
  const headLimit = Math.min(headBytes, maxBytes);
  const tailLimit = maxBytes - headLimit;
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  const counts = { head: 0, tail: 0, dropped: 0 };

  const writeTail = (chunk: Uint8Array): void => {
    if (tailLimit === 0) {
      counts.dropped += chunk.byteLength;

      return;
    }

    tail.push(chunk);

    counts.tail += chunk.byteLength;

    while (counts.tail > tailLimit) {
      const [first] = tail;

      if (first === undefined) {
        break;
      }

      const excess = counts.tail - tailLimit;

      if (first.byteLength <= excess) {
        tail.shift();

        counts.tail -= first.byteLength;
        counts.dropped += first.byteLength;
      } else {
        tail[0] = first.subarray(excess);
        counts.tail -= excess;
        counts.dropped += excess;
      }
    }
  };

  return {
    push: (chunk) => {
      const room = headLimit - counts.head;

      if (room > 0) {
        const taken = chunk.subarray(0, room);

        head.push(taken);

        counts.head += taken.byteLength;

        if (taken.byteLength === chunk.byteLength) {
          return;
        }

        writeTail(chunk.subarray(room));

        return;
      }

      writeTail(chunk);
    },
    finish: () => ({
      head: mergeBytes(head),
      tail: mergeBytes(tail),
      droppedBytes: counts.dropped,
    }),
  };
}

export function formatCappedText(output: Readonly<CappedOutput>): string {
  const decoder = new TextDecoder();

  if (output.droppedBytes === 0) {
    return decoder.decode(mergeBytes([output.head, output.tail]));
  }

  const headEnd = getHeadEnd(output.head);
  const tailStart = getTailStart(output.tail);
  const head = output.head.subarray(0, headEnd);
  const tail = output.tail.subarray(tailStart);
  const dropped = output.droppedBytes + (output.head.byteLength - headEnd) + tailStart;

  return `${decoder.decode(head)}\n[... ${String(dropped)} bytes dropped ...]\n${decoder.decode(tail)}`;
}

const MAX_CHARACTER_BYTES = 4;

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function countCharacterBytes(lead: number): number {
  if (lead >= 0xf0) {
    return 4;
  }

  if (lead >= 0xe0) {
    return 3;
  }

  return lead >= 0xc0 ? 2 : 1;
}

function getHeadEnd(head: Uint8Array): number {
  for (let back = 1; back <= Math.min(MAX_CHARACTER_BYTES, head.byteLength); back++) {
    const start = head.byteLength - back;
    const byte = head[start] ?? 0;

    if (!isContinuation(byte)) {
      return start + countCharacterBytes(byte) > head.byteLength ? start : head.byteLength;
    }
  }

  return head.byteLength;
}

function getTailStart(tail: Uint8Array): number {
  let start = 0;

  while (
    start < MAX_CHARACTER_BYTES - 1 &&
    start < tail.byteLength &&
    isContinuation(tail[start] ?? 0)
  ) {
    start++;
  }

  return start;
}
