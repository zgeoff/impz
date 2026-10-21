import type {
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '../../src/vm/agent-client/exec-stream';

export interface StubRun {
  readonly argv: readonly string[];

  readonly readStdin: () => Promise<Uint8Array>;
}

export interface StubAnswer {
  readonly stdout?: string | readonly Uint8Array[] | AsyncIterable<Uint8Array>;
  readonly stderr?: string;
  readonly code?: number;

  readonly stall?: boolean;

  readonly isDropped?: boolean;
}

interface FakeRecord {
  readonly argv: readonly string[];
  readonly signals: number[];
  closed: boolean;
}

export function buildStubGuest(answer: (run: StubRun) => Promise<StubAnswer> | StubAnswer) {
  const runs: FakeRecord[] = [];

  const open = (request: AgentExecRequest): Promise<ExecStream> => {
    const record: FakeRecord = { argv: request.argv, signals: [], closed: false };
    const stdin: Uint8Array[] = [];
    const stdinDone = Promise.withResolvers<Uint8Array>();
    const closed = Promise.withResolvers<null>();

    runs.push(record);

    const answering = Promise.race([
      Promise.resolve(answer({ argv: request.argv, readStdin: () => stdinDone.promise })),
      closed.promise,
    ]);

    return Promise.resolve({
      pid: runs.length,
      session: null,
      created: false,
      groupKill: true,
      output: null,
      writeStdin: (data) => {
        stdin.push(data);
      },
      stdinDrained: () => Promise.resolve(),
      closeStdin: () => {
        stdinDone.resolve(Buffer.concat(stdin));
      },
      resize: () => {},
      sendSignal: (signal) => {
        record.signals.push(signal);
      },
      events: () => readFakeEvents(answering, closed.promise, () => record.closed),
      close: () => {
        record.closed = true;

        closed.resolve(null);
      },
    });
  };

  return { open, runs };
}

const encoder = new TextEncoder();

async function* readFakeEvents(
  answering: Promise<StubAnswer | null>,
  closing: Promise<null>,
  isClosed: () => boolean,
): AsyncGenerator<ExecEvent, void, undefined> {
  const answered = await answering;

  if (answered === null) {
    return;
  }

  const stdout =
    typeof answered.stdout === 'string' ? [encoder.encode(answered.stdout)] : answered.stdout;

  const chunks = readChunks(stdout ?? []);

  for (;;) {
    const next = await Promise.race([chunks.next(), closing]);

    if (next === null || isClosed()) {
      return;
    }

    if (next.done === true) {
      break;
    }

    yield { type: 'stdout', data: next.value };
  }

  if (answered.stderr !== undefined) {
    yield { type: 'stderr', data: encoder.encode(answered.stderr) };
  }

  if (answered.isDropped === true) {
    return;
  }

  if (answered.stall === true) {
    await closing;

    return;
  }

  yield { type: 'exit', code: answered.code ?? 0, signal: 0 };
}

async function* readChunks(
  source: readonly Uint8Array[] | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  yield* source;
}
