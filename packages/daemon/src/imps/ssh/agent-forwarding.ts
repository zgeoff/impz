import type { Connection, ServerChannel } from 'ssh2';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { GuestListener } from '../../vm/agent-client/listener-stream';
import { runGuestListener } from '../reverse/run-guest-listener';
import { formatFailure, runChannelRelay } from './channel-io';
import type { SshBackend } from './ssh-connection-context';

/* @internal */
export const MAX_AGENT_CHANNELS = 16;

export interface AgentForwarding {
  readonly enable: () => void;
  readonly readSocket: () => Promise<string | null>;
  readonly stop: () => void;
}

interface AgentForwardingDeps {
  readonly client: Connection;
  readonly impName: string;
  readonly backend: Pick<SshBackend, 'requireRunning' | 'openListener' | 'openAccept'>;
}

async function stopListenerWhenOpen(listening: Promise<GuestListener>): Promise<void> {
  try {
    const listener = await listening;

    listener.close();
  } catch {}
}

export function createAgentForwarding(deps: AgentForwardingDeps): AgentForwarding {
  const state: {
    listening: Promise<GuestListener> | null;
    generation: number;
    pid: number | null;
    channels: number;
    enabled: boolean;
    stopped: boolean;
  } = {
    listening: null,
    generation: 0,
    pid: null,
    channels: 0,
    enabled: false,
    stopped: false,
  };

  const stopListener = (): void => {
    const listening = state.listening;

    state.listening = null;
    state.generation += 1;

    if (listening !== null) {
      void stopListenerWhenOpen(listening);
    }
  };

  const writeLog = (message: string): void => {
    getImpdLogger('ssh')
      .with({ imp: deps.impName })
      .info('agent forwarding: {message}', { message });
  };

  const stopGuestClient = async (listener: GuestListener, id: number): Promise<void> => {
    try {
      const stream = await deps.backend.openAccept(deps.impName, listener.id, id, 'ssh');

      stream.close();
    } catch {}
  };

  const openClientChannel = (): Promise<ServerChannel> =>
    new Promise((resolve, reject) => {
      deps.client.openssh_authAgent((failure, channel) => {
        if (failure === undefined) {
          resolve(channel);
        } else {
          reject(failure);
        }
      });
    });

  // A client with no agent refuses the channel, and closing the guest client at once makes
  // `ssh-add` fail fast instead of hanging.
  const sendToClientAgent = async (listener: GuestListener, id: number): Promise<void> => {
    let channel: ServerChannel;

    try {
      channel = await openClientChannel();
    } catch (error) {
      writeLog(`the client refused the agent channel: ${formatFailure(error)}`);

      await stopGuestClient(listener, id);

      return;
    }

    try {
      const relay = await deps.backend.openAccept(deps.impName, listener.id, id, 'ssh');

      await runChannelRelay(channel, relay);
    } catch (error) {
      channel.destroy();

      writeLog(formatFailure(error));
    }
  };

  const handleConnection = async (listener: GuestListener, id: number): Promise<void> => {
    state.channels += 1;

    try {
      await sendToClientAgent(listener, id);
    } finally {
      state.channels -= 1;
    }
  };

  const runListener = async (listener: GuestListener, generation: number): Promise<void> => {
    try {
      await runGuestListener(listener, {
        deliver: (id) => handleConnection(listener, id),
        refuse: (id) => stopGuestClient(listener, id),
        isFull: () => state.channels >= MAX_AGENT_CHANNELS,
      });
    } catch (error) {
      writeLog(`the guest socket ended: ${formatFailure(error)}`);
    } finally {
      listener.close();

      if (state.generation === generation) {
        state.listening = null;
      }
    }
  };

  const openListener = async (generation: number): Promise<GuestListener> => {
    let listener: GuestListener;

    try {
      listener = await deps.backend.openListener(deps.impName, { network: 'ssh-agent' }, 'ssh');
    } catch (error) {
      if (state.generation === generation) {
        state.listening = null;
      }

      throw error;
    }

    if (state.stopped) {
      listener.close();
      throw new Error('the SSH connection closed');
    }

    void runListener(listener, generation);

    return listener;
  };

  return {
    enable: () => {
      state.enabled = true;
    },
    readSocket: async () => {
      if (!state.enabled) {
        return null;
      }

      // impd may learn that a forced sleep reset the listener's agent connection only after the
      // next session asks, so a new VM pid restarts the listener.
      const running = await deps.backend.requireRunning(deps.impName);

      if (state.listening !== null && state.pid !== running.imp.pid) {
        stopListener();
      }

      if (state.listening === null) {
        state.generation += 1;
        state.pid = running.imp.pid;
        state.listening = openListener(state.generation);
      }

      const listener = await state.listening;

      return listener.path ?? null;
    },
    stop: () => {
      state.stopped = true;

      stopListener();
    },
  };
}
