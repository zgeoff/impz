import type { AuditActor } from '../../src/identity/auth/caller';
import { buildActivityTracker } from '../../src/imps/imps/activity-tracker';
import type { ConnectionKind } from '../../src/imps/imps/activity-tracker';
import type { ImpRuntime } from '../../src/imps/imps/imp-runtime';
import type { SshBackend } from '../../src/imps/ssh/ssh-connection-context';
import type { ImpRecord } from '../../src/platform/db/imps';
import { buildNotFoundError } from '../../src/surface/api-errors';
import type { DialEvent, DialStream, DialTarget } from '../../src/vm/agent-client/dial-stream';
import type {
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '../../src/vm/agent-client/exec-stream';
import type { GuestListener, ListenSpec } from '../../src/vm/agent-client/listener-stream';

interface StubExec {
  readonly request: AgentExecRequest;
  readonly feature: string | undefined;
  readonly stdin: readonly string[];
  readonly resizes: readonly string[];
  readonly signals: readonly number[];
  readonly emit: (event: ExecEvent | null) => void;
}

interface StubDial {
  readonly target: DialTarget;
  readonly kind: ConnectionKind;
  readonly input: readonly string[];
}

interface StubListener {
  readonly id: string;
  readonly spec: ListenSpec;
  readonly kind: ConnectionKind | null;
  readonly connect: (id: number) => void;
  readonly end: () => void;
  readonly state: { closed: boolean };
}

interface StubAccept {
  readonly listener: string;
  readonly id: number;
  readonly kind: ConnectionKind;
  readonly input: readonly string[];
  readonly send: (data: string) => void;
  readonly sendEof: () => void;
  readonly state: { closed: boolean; ended: boolean };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function buildStubSshBackend() {
  const imps = new Map<string, ImpRecord>();

  const execs: StubExec[] = [];
  const dials: StubDial[] = [];
  const listeners: StubListener[] = [];
  const accepts: StubAccept[] = [];
  const tracker = buildActivityTracker();
  const actors: AuditActor[] = [];
  const activity: string[] = [];

  const stub: {
    wakes: number;
    lookups: number;
    findError: Error | null;
    wakeError: Error | null;
    execError: Error | null;
    dialError: Error | null;
    listenError: Error | null;
    wokeMs: number | null;
    listenCalls: number;
    listenGate: Promise<void> | null;
    stdinGate: Promise<void> | null;
    onExec: ((exec: StubExec) => void) | null;
  } = {
    wakes: 0,
    lookups: 0,
    findError: null,
    wakeError: null,
    execError: null,
    dialError: null,
    listenError: null,
    wokeMs: null,
    listenCalls: 0,
    listenGate: null,
    stdinGate: null,
    onExec: null,
  };

  const countStream = (name: string, kind: ConnectionKind | null): (() => void) => {
    const imp = imps.get(name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return kind === null ? () => {} : tracker.open(imp.id, kind);
  };

  const openExec = async (
    name: string,
    request: AgentExecRequest,
    feature: string | undefined,
    actor?: AuditActor,
  ): Promise<ExecStream> => {
    if (actor !== undefined) {
      actors.push(actor);
    }

    if (stub.execError !== null) {
      throw stub.execError;
    }

    const release = countStream(name, 'exec');
    const queue = createEventQueue<ExecEvent>();
    const stdin: string[] = [];
    const resizes: string[] = [];
    const signals: number[] = [];
    const exec: StubExec = { request, feature, stdin, resizes, signals, emit: queue.emit };

    execs.push(exec);
    stub.onExec?.(exec);

    await Promise.resolve();

    return {
      pid: 42,
      session: null,
      created: false,
      groupKill: false,
      output: null,
      writeStdin: (data: Uint8Array) => {
        stdin.push(decoder.decode(data));
      },
      stdinDrained: () => stub.stdinGate ?? Promise.resolve(),
      closeStdin: () => {
        stdin.push('<eof>');
      },
      resize: (cols: number, rows: number) => {
        resizes.push(`${String(cols)}x${String(rows)}`);
      },
      sendSignal: (signal: number) => {
        signals.push(signal);
      },
      events: () => readEvents(queue.next),
      close: () => {
        release();

        queue.emit(null);
      },
    };
  };

  const openDial: SshBackend['openDial'] = async (name, target, kind) => {
    if (stub.dialError !== null) {
      throw stub.dialError;
    }

    const release = countStream(name, kind);
    const queue = createEventQueue<DialEvent>();
    const input: string[] = [];

    dials.push({ target, kind, input });

    const stream: DialStream = {
      write: (data) => {
        input.push(decoder.decode(data));
      },
      drained: () => Promise.resolve(),
      end: () => {
        queue.emit({ type: 'data', data: encoder.encode(`got ${input.join('')}`) });
        queue.emit({ type: 'eof' });
        queue.emit(null);
      },
      events: () => readEvents(queue.next),
      close: () => {
        release();

        queue.emit(null);
      },
    };

    await Promise.resolve();

    return stream;
  };

  const openListener: SshBackend['openListener'] = async (name, spec, kind) => {
    stub.listenCalls += 1;

    await stub.listenGate;

    if (stub.listenError !== null) {
      throw stub.listenError;
    }

    const release = countStream(name, kind);
    const queue = createEventQueue<number>();
    const id = `stub${String(listeners.length + 1)}`;
    const state = { closed: false };

    listeners.push({
      id,
      spec,
      kind,
      connect: queue.emit,
      end: () => {
        queue.emit(null);
      },
      state,
    });

    const listener: GuestListener = {
      path: readStubPath(spec, id),
      port: spec.network === 'tcp' ? spec.port || 40_000 + listeners.length : null,
      id,
      connections: () => readEvents(queue.next),
      close: () => {
        state.closed = true;

        release();

        queue.emit(null);
      },
    };

    return listener;
  };

  const openAccept: SshBackend['openAccept'] = async (name, listener, id, kind) => {
    const release = countStream(name, kind);
    const queue = createEventQueue<DialEvent>();
    const input: string[] = [];
    const state = { closed: false, ended: false };
    const halves = { isClientDone: false, isGuestDone: false };

    // the agent ends a relay once neither side will send more
    const stopWhenDone = (): void => {
      if (halves.isClientDone && halves.isGuestDone) {
        state.ended = true;

        queue.emit(null);
      }
    };

    accepts.push({
      listener,
      id,
      kind,
      input,
      send: (data) => {
        queue.emit({ type: 'data', data: encoder.encode(data) });
      },
      sendEof: () => {
        halves.isGuestDone = true;

        queue.emit({ type: 'eof' });

        stopWhenDone();
      },
      state,
    });

    const stream: DialStream = {
      write: (data) => {
        input.push(decoder.decode(data));
      },
      drained: () => Promise.resolve(),

      end: () => {
        halves.isClientDone = true;

        input.push('<eof>');

        stopWhenDone();
      },
      events: () => readEvents(queue.next),
      close: () => {
        state.closed = true;
        state.ended = true;

        release();

        queue.emit(null);
      },
    };

    await Promise.resolve();

    return stream;
  };

  const backend: SshBackend & Pick<ImpRuntime, 'openExec'> = {
    readImp: (name) => {
      stub.lookups += 1;

      if (stub.findError !== null) {
        return Promise.reject(stub.findError);
      }

      return Promise.resolve(imps.get(name));
    },

    requireRunning: (name) => {
      stub.wakes += 1;

      if (stub.wakeError !== null) {
        return Promise.reject(stub.wakeError);
      }

      const imp = imps.get(name);

      if (imp === undefined) {
        return Promise.reject(buildNotFoundError('imp', name));
      }

      return Promise.resolve({ imp, wokeMs: stub.wokeMs });
    },
    tracker,
    recordActivity: (name) => {
      activity.push(name);

      return Promise.resolve();
    },
    openExec,
    openDial,
    openListener,
    openAccept,
  };

  return {
    backend,
    stub,
    actors,
    activity,
    execs,
    dials,
    listeners,
    accepts,
    tracker,

    putImp: (imp: ImpRecord): void => {
      imps.set(imp.name, imp);
    },
  };
}

interface EventQueue<T> {
  readonly emit: (event: T | null) => void;
  readonly next: () => Promise<T | null>;
}

function createEventQueue<T>(): EventQueue<T> {
  const events: (T | null)[] = [];
  const waiter: { wake: (() => void) | null } = { wake: null };

  return {
    emit: (event) => {
      events.push(event);
      waiter.wake?.();
    },
    next: async () => {
      while (events.length === 0) {
        await new Promise<void>((resolve) => {
          waiter.wake = resolve;
        });
      }

      return events.shift() ?? null;
    },
  };
}

async function* readEvents<T>(next: () => Promise<T | null>): AsyncGenerator<T, void, undefined> {
  for (;;) {
    const event = await next();

    if (event === null) {
      return;
    }

    yield event;
  }
}

function readStubPath(spec: ListenSpec, id: string): string | null {
  if (spec.network === 'ssh-agent') {
    return `/run/imp/ssh-agent/${id}/agent.sock`;
  }

  return spec.network === 'unix' ? (spec.path ?? `/run/imp/forward/${id}/sock`) : null;
}
