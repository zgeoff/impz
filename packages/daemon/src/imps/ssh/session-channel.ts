import { CONSOLE_SHELL } from '@impz/api';
import type { AcceptConnection, PseudoTtyInfo, ServerChannel, Session } from 'ssh2';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import type { AgentExecRequest, ExecStream } from '../../vm/agent-client/exec-stream';
import { SYSTEM_AGENT_PATH } from '../exec/exec-tools';
import { findSignalNumber, getSignalName } from '../exec/signal-names';
import { formatFailure, startChannelInput, writeToChannel } from './channel-io';
import type { SshConnectionContext } from './ssh-connection-context';

const SFTP_ARGV = [SYSTEM_AGENT_PATH, 'sftp'];

// OpenSSH's default AcceptEnv takes only these variables.
const ACCEPTED_ENV = /^(?:LANG|LC_[A-Z_]+)$/u;

// ssh2 passes no accept or reject for a request that wants no reply, and OpenSSH sends env,
// window-change and signal that way.
type Reply = (() => void) | undefined;

interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

interface Program {
  readonly argv: readonly string[];
  readonly allowsTty: boolean;
  readonly feature?: AgentFeature;
}

export function handleSession(session: Session, context: SshConnectionContext): void {
  const state: {
    pty: PseudoTtyInfo | null;
    started: boolean;
    stream: ExecStream | null;
    env: Map<string, string>;
  } = { pty: null, started: false, stream: null, env: new Map() };

  session.on('pty', (accept: Reply, reject: Reply, info) => {
    if (state.started) {
      reject?.();

      return;
    }

    state.pty = info;
    accept?.();
  });

  session.on('window-change', (accept: Reply, _reject: Reply, info) => {
    if (state.pty !== null) {
      state.pty = { ...state.pty, cols: info.cols, rows: info.rows };
    }

    if (isTerminalSize(info)) {
      state.stream?.resize(info.cols, info.rows);
    }

    accept?.();
  });

  session.on('env', (accept: Reply, reject: Reply, info) => {
    if (state.started || !ACCEPTED_ENV.test(info.key)) {
      reject?.();

      return;
    }

    state.env.set(info.key, info.val);
    accept?.();
  });

  session.on('signal', (accept: Reply, reject: Reply, info) => {
    const signal = findSignalNumber(`SIG${info.name}`);

    if (signal === undefined || state.stream === null) {
      reject?.();

      return;
    }

    state.stream.sendSignal(signal);
    accept?.();
  });

  // OpenSSH wants no reply to auth-agent, so a later forwarding failure shows on stderr instead.
  session.on('auth-agent', (accept: Reply, reject: Reply) => {
    if (state.started) {
      reject?.();

      return;
    }

    context.agent.enable();
    accept?.();
  });

  session.on('x11', (_accept: Reply, reject: Reply) => {
    reject?.();
  });

  const start = async (
    accept: AcceptConnection<ServerChannel>,
    program: Program,
  ): Promise<void> => {
    state.started = true;

    const channel = accept();

    try {
      await runProgram(channel, program);
    } catch (error) {
      context.log(`impd: ssh: ${context.impName}: ${formatFailure(error)}`);
      channel.destroy();
    }
  };

  const runProgram = async (channel: ServerChannel, program: Program): Promise<void> => {
    const tty = program.allowsTty && state.pty !== null;
    const closed = { value: false };

    channel.once('close', () => {
      closed.value = true;
      state.stream?.close();
    });

    // Without a pty the client's terminal is not raw, and a \r would show.
    const newline = tty ? '\r\n' : '\n';
    let stream: ExecStream;
    let request: AgentExecRequest;

    try {
      await context.awake;

      const agentSocket = program.allowsTty ? await readAgentSocket(channel, newline) : null;

      request = buildRequest(program, tty, agentSocket);

      stream = await context.backend.openExec(
        context.impName,
        request,
        program.feature,
        context.actor,
      );
    } catch (error) {
      channel.stderr.write(`imp: ${formatFailure(error)}${newline}`);
      channel.exit(255);
      channel.end();

      return;
    }

    if (closed.value) {
      stream.close();

      return;
    }

    state.stream = stream;

    const size = tty ? findSize() : null;

    if (size !== null && (size.cols !== request.cols || size.rows !== request.rows)) {
      stream.resize(size.cols, size.rows);
    }

    startChannelInput(channel, {
      write: stream.writeStdin,
      drained: stream.stdinDrained,
      end: stream.closeStdin,
    });

    try {
      await sendOutput(channel, stream, newline);
    } finally {
      stream.close();

      await context.backend.recordActivity(context.impName).catch(() => null);
    }
  };

  // OpenSSH sends a 0x0 pty when its own stdin is not a terminal, and the agent then uses 80x24.
  const findSize = (): TerminalSize | null =>
    state.pty !== null && isTerminalSize(state.pty)
      ? { cols: state.pty.cols, rows: state.pty.rows }
      : null;

  const readAgentSocket = async (
    channel: ServerChannel,
    newline: string,
  ): Promise<string | null> => {
    try {
      return await context.agent.readSocket();
    } catch (error) {
      channel.stderr.write(`imp: no agent forwarding: ${formatFailure(error)}${newline}`);

      return null;
    }
  };

  const buildRequest = (
    program: Program,
    tty: boolean,
    agentSocket: string | null,
  ): AgentExecRequest => {
    const env = [...state.env].map(([key, value]) => `${key}=${value}`);

    env.push(...context.sshEnv);

    if (agentSocket !== null) {
      env.push(`SSH_AUTH_SOCK=${agentSocket}`);
    }

    if (tty && state.pty !== null && state.pty.term !== '') {
      env.push(`TERM=${state.pty.term}`);
    }

    const size = tty ? findSize() : null;

    return { argv: program.argv, env, tty, ...size };
  };

  const handleRestart = (reject: Reply): boolean => {
    if (state.started) {
      reject?.();
    }

    return state.started;
  };

  session.on('shell', (accept, reject: Reply) => {
    if (!handleRestart(reject)) {
      void start(accept, { argv: ['/bin/sh', '-c', CONSOLE_SHELL], allowsTty: true });
    }
  });

  // OpenSSH runs a command with the user's shell, and /bin/sh is the shell every image with a
  // shell has.
  session.on('exec', (accept, reject: Reply, info) => {
    if (!handleRestart(reject)) {
      void start(accept, { argv: ['/bin/sh', '-c', info.command], allowsTty: true });
    }
  });

  session.on('subsystem', (accept, reject: Reply, info) => {
    if (handleRestart(reject)) {
      return;
    }

    if (info.name !== 'sftp') {
      reject?.();

      return;
    }

    void start(accept, { argv: SFTP_ARGV, allowsTty: false, feature: 'ssh' });
  });
}

function isTerminalSize(size: TerminalSize): boolean {
  return size.cols > 0 && size.rows > 0;
}

// A stream that ends without an exit lost the agent connection, and the agent sends the process
// SIGHUP then, so the client gets HUP.
async function sendOutput(
  channel: ServerChannel,
  stream: ExecStream,
  newline: string,
): Promise<void> {
  for await (const event of stream.events()) {
    if (event.type === 'stdout') {
      await writeToChannel(channel, event.data);
    } else if (event.type === 'stderr') {
      await writeToChannel(channel.stderr, event.data);
    } else if (event.type === 'exit') {
      sendExit(channel, event.code, event.signal);

      channel.end();

      return;
    }
  }

  channel.stderr.write(`imp: lost the connection to the imp${newline}`);
  channel.exit('HUP', false, 'lost the connection to the imp');
  channel.end();
}

// RFC 4254 section 6.10 lists the signals an SSH exit-signal may name.
const EXIT_SIGNALS = new Set([
  'ABRT',
  'ALRM',
  'FPE',
  'HUP',
  'ILL',
  'INT',
  'KILL',
  'PIPE',
  'QUIT',
  'SEGV',
  'TERM',
  'USR1',
  'USR2',
]);

function sendExit(channel: ServerChannel, code: number, signal: number): void {
  const name = signal === 0 ? null : getSignalName(signal).replace(/^SIG/u, '');

  if (name !== null && EXIT_SIGNALS.has(name)) {
    channel.exit(name, false, '');
  } else {
    channel.exit(code);
  }
}
