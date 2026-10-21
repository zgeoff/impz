import type { SessionOutput } from '@impz/api';
import type { ExecEvent, ExecStream } from '../../src/vm/agent-client/exec-stream';

interface TapState {
  closed: boolean;
  dropped: boolean;
  finished: boolean;
}

interface TapSource {
  readonly queue: ExecEvent[];
  readonly state: TapState;
  readonly waiting: { wake: (() => void) | null };
}

export function buildStubTapStream(output: SessionOutput) {
  const source: TapSource = {
    queue: [],
    state: { closed: false, dropped: false, finished: false },
    waiting: { wake: null },
  };

  const wake = (): void => {
    source.waiting.wake?.();
    source.waiting.wake = null;
  };

  const readNext = async (): Promise<ExecEvent | null> => {
    for (;;) {
      if (source.state.closed) {
        return null;
      }

      const event = source.queue.shift();

      if (event !== undefined) {
        return event;
      }

      if (source.state.dropped) {
        return null;
      }

      await new Promise<void>((resolve) => {
        source.waiting.wake = resolve;
      });
    }
  };

  const setFinished = (): void => {
    source.state.finished = true;
  };

  const stream: ExecStream = {
    pid: 1,
    session: 'main',
    created: false,
    groupKill: false,
    output,
    writeStdin: () => {},
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {},
    resize: () => {},
    sendSignal: () => {},
    events: () => readTapEvents(readNext, setFinished),
    close: () => {
      source.state.closed = true;

      wake();
    },
  };

  return {
    stream,
    state: source.state,
    emitEvent: (event: ExecEvent): void => {
      source.queue.push(event);

      wake();
    },
    write: (text: string): void => {
      source.queue.push({ type: 'stdout', data: new TextEncoder().encode(text) });

      wake();
    },
    drop: (): void => {
      source.state.dropped = true;

      wake();
    },
  };
}

async function* readTapEvents(
  readNext: () => Promise<ExecEvent | null>,
  setFinished: () => void,
): AsyncGenerator<ExecEvent, void, undefined> {
  try {
    for (;;) {
      const event = await readNext();

      if (event === null) {
        return;
      }

      yield event;

      if (event.type === 'exit' || event.type === 'detached') {
        return;
      }
    }
  } finally {
    setFinished();
  }
}
