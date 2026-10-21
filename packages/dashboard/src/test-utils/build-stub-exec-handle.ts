import type { ExecExit, ExecHandle } from '@impz/client';

interface StubExecHandleOptions {
  readonly exit: Promise<ExecExit>;
}

export function buildStubExecHandle(options: StubExecHandleOptions) {
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();

  const calls: unknown[][] = [];

  const handle: ExecHandle = {
    started: Promise.resolve({
      pid: 1,
      session: null,
      created: true,
      groupKill: false,
      output: { continuity: 'none' },
    }),
    stdout: stdout.readable,
    stderr: stderr.readable,
    exit: options.exit,
    write: (data) => {
      calls.push(['write', data]);

      return Promise.resolve();
    },
    closeStdin: () => Promise.resolve(),
    resize: (cols, rows) => {
      calls.push(['resize', cols, rows]);
    },
    sendSignal: () => {},
    close: () => {
      calls.push(['close']);
    },
  };

  return {
    handle,
    calls,
    stdout: stdout.writable.getWriter(),
    stderr: stderr.writable.getWriter(),
  };
}
