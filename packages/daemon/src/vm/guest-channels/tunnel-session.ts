import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
  TunnelClientMessageSchema,
} from '@impz/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@impz/api';
import { ImpdError } from '../../platform/errors/impd-error';
import { createCountedLimit } from '../../platform/process/counted-limit';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { AgentError } from '../agent-client/agent-connection';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import type { ReverseForwards } from './reverse-forwards';
import { runGuestListener } from './run-guest-listener';

const MAX_TUNNELS_PER_IMP = 256;
const MAX_PENDING_BYTES = TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES;

export interface TunnelPeer {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (data: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface TunnelBackend {
  readonly readImpId: (name: string) => Promise<string>;
  readonly openDial: (name: string, target: DialTarget) => Promise<DialStream>;
  readonly openListener: (name: string, spec: ListenSpec) => Promise<GuestListener>;
  readonly openAccept: (name: string, listener: string, connection: number) => Promise<DialStream>;
  readonly owner: string;
}

export interface TunnelSession {
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;
}

type TunnelListen = Extract<TunnelClientMessage, { type: 'listen' }>;

export interface TunnelLimits {
  readonly max: number;
  readonly tryOpen: (impId: string) => (() => void) | null;
}

export function createTunnelLimits(max = MAX_TUNNELS_PER_IMP): TunnelLimits {
  const counts = createCountedLimit(max);

  return { max, tryOpen: counts.tryClaim };
}

function buildErrorMessage(error: unknown): TunnelServerMessage {
  if (error instanceof ImpdError) {
    return { type: 'error', code: String(error.code), message: error.message };
  }

  if (error instanceof AgentError) {
    return { type: 'error', code: error.code, message: error.detail };
  }

  return { type: 'error', message: getErrorMessage(error) };
}

export function createTunnelSession(
  peer: TunnelPeer,
  backend: TunnelBackend,
  limits: TunnelLimits,
  forwards: ReverseForwards,
): TunnelSession {
  const state: {
    phase: 'waiting' | 'opening' | 'open' | 'listening' | 'closed';
    stream: DialStream | null;
    listener: GuestListener | null;
    release: () => void;
    unacked: number;
    ackWaiter: (() => void) | null;
    pendingAck: number;
    acking: boolean;
    guestEof: boolean;
    peerEof: boolean;
  } = {
    phase: 'waiting',
    stream: null,
    listener: null,
    release: () => {},
    unacked: 0,
    ackWaiter: null,
    pendingAck: 0,
    acking: false,
    guestEof: false,
    peerEof: false,
  };

  const send = (message: TunnelServerMessage): void => {
    peer.sendText(JSON.stringify(message));
  };

  const stopTunnel = (code: number, reason: string): void => {
    if (state.phase === 'closed') {
      return;
    }

    state.phase = 'closed';
    state.stream?.close();
    state.listener?.close();
    state.release();
    state.ackWaiter?.();
    peer.close(code, reason);
  };

  const stopWithError = (error: unknown): void => {
    if (state.phase === 'closed') {
      return;
    }

    send(buildErrorMessage(error));
    stopTunnel(TUNNEL_CLOSE_NORMAL, 'tunnel failed');
  };

  const waitForWindow = async (): Promise<void> => {
    while (state.phase === 'open' && state.unacked > TUNNEL_WINDOW_BYTES) {
      await new Promise<void>((resolve) => {
        state.ackWaiter = resolve;
      });

      state.ackWaiter = null;
    }
  };

  const sendGuestOutput = async (stream: DialStream): Promise<void> => {
    for await (const event of stream.events()) {
      if (event.type === 'eof') {
        state.guestEof = true;

        send({ type: 'eof' });
        continue;
      }

      await waitForWindow();

      if (state.phase !== 'open') {
        return;
      }

      peer.sendBinary(event.data);

      state.unacked += event.data.byteLength;
    }

    // The agent ends a relay once both sides have sent eof, so any other end is a lost connection.
    const complete = state.guestEof && state.peerEof;
    const code = complete ? TUNNEL_CLOSE_NORMAL : TUNNEL_CLOSE_LOST;
    const reason = complete ? 'done' : 'lost';

    stopTunnel(code, reason);
  };

  const runTunnel = async (stream: DialStream): Promise<void> => {
    try {
      await sendGuestOutput(stream);
    } catch {
      stopTunnel(TUNNEL_CLOSE_LOST, 'lost');
    }
  };

  const sendPeerAcks = async (stream: DialStream): Promise<void> => {
    state.acking = true;

    while (state.pendingAck > 0 && state.phase === 'open') {
      const bytes = state.pendingAck;

      await stream.drained();

      state.pendingAck -= bytes;

      if (state.phase === 'open') {
        send({ type: 'ack', bytes });
      }
    }

    state.acking = false;
  };

  const readOpeningImp = async (name: string): Promise<string | null> => {
    state.phase = 'opening';

    try {
      const impId = await backend.readImpId(name);

      return state.phase === 'opening' ? impId : null;
    } catch (error) {
      stopWithError(error);

      return null;
    }
  };

  const buildLimitError = (name: string): ImpdError<'TUNNEL_LIMIT'> =>
    new ImpdError('TUNNEL_LIMIT', {
      message: `${name} has ${String(limits.max)} ${limits.max === 1 ? 'tunnel' : 'tunnels'} open already`,
    });

  const openTunnel = async (
    name: string,
    reserve: (impId: string) => () => void,
    open: () => Promise<DialStream>,
  ): Promise<void> => {
    const impId = await readOpeningImp(name);

    if (impId === null) {
      return;
    }

    let stream: DialStream;

    try {
      state.release = reserve(impId);

      stream = await open();
    } catch (error) {
      stopWithError(error);

      return;
    }

    if (state.phase !== 'opening') {
      stream.close();

      return;
    }

    state.stream = stream;
    state.phase = 'open';

    send({ type: 'opened' });
    void runTunnel(stream);
  };

  const allocateTunnel = (name: string, impId: string): (() => void) => {
    const release = limits.tryOpen(impId);

    if (release === null) {
      throw buildLimitError(name);
    }

    return release;
  };

  const allocateRelay = (name: string, listener: string, impId: string): (() => void) => {
    const relay = forwards.tryAccept(listener, impId, backend.owner);

    if ('refused' in relay) {
      throw relay.refused === 'full'
        ? new ImpdError('TUNNEL_LIMIT', {
            message: `the reverse forward has its most relays open already`,
          })
        : new ImpdError('NOT_FOUND', {
            message: `no reverse forward ${listener} of yours on ${name}`,
          });
    }

    try {
      const release = allocateTunnel(name, impId);

      return () => {
        release();

        relay.release();
      };
    } catch (error) {
      relay.release();
      throw error;
    }
  };

  const stopGuestClient = async (name: string, listener: string, id: number): Promise<void> => {
    try {
      const stream = await backend.openAccept(name, listener, id);

      stream.close();
    } catch {}
  };

  const runForward = async (name: string, listener: GuestListener): Promise<void> => {
    try {
      await runGuestListener(listener, {
        deliver: (id) => {
          send({ type: 'connection', id });

          return Promise.resolve();
        },
        refuse: (id) => stopGuestClient(name, listener.id, id),
        isFull: () => forwards.isFull(listener.id),
      });
    } catch {}

    stopTunnel(TUNNEL_CLOSE_LOST, 'lost');
  };

  const openForward = async (control: TunnelListen): Promise<void> => {
    const impId = await readOpeningImp(control.name);

    if (impId === null) {
      return;
    }

    const spec: ListenSpec =
      control.network === 'tcp'
        ? { network: 'tcp', port: control.port ?? 0 }
        : { network: 'unix', path: control.path ?? null };

    let listener: GuestListener;

    try {
      state.release = allocateTunnel(control.name, impId);

      listener = await backend.openListener(control.name, spec);
    } catch (error) {
      stopWithError(error);

      return;
    }

    if (state.phase !== 'opening') {
      listener.close();

      return;
    }

    const releaseTunnel = state.release;
    const releaseForward = forwards.register(listener.id, impId, backend.owner);

    state.listener = listener;

    state.release = () => {
      releaseForward();
      releaseTunnel();
    };

    state.phase = 'listening';

    send({ type: 'listening', listener: listener.id, path: listener.path, port: listener.port });
    void runForward(control.name, listener);
  };

  const handleControl = (message: unknown): void => {
    const parsed = TunnelClientMessageSchema.safeParse(message);

    if (!parsed.success) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'bad message');

      return;
    }

    const control = parsed.data;

    if (control.type === 'open' || control.type === 'listen' || control.type === 'accept') {
      if (state.phase !== 'waiting') {
        stopTunnel(TUNNEL_CLOSE_PROTOCOL, `${control.type} after the start`);
      } else if (control.type === 'open') {
        const name = control.name;
        const target: DialTarget = { network: 'tcp', address: `127.0.0.1:${String(control.port)}` };

        void openTunnel(
          name,
          (impId) => allocateTunnel(name, impId),
          () => backend.openDial(name, target),
        );
      } else if (control.type === 'accept') {
        const name = control.name;

        void openTunnel(
          name,
          (impId) => allocateRelay(name, control.listener, impId),
          () => backend.openAccept(name, control.listener, control.connection),
        );
      } else {
        void openForward(control);
      }

      return;
    }

    const stream = state.stream;

    if (state.phase !== 'open' || stream === null) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, `${control.type} before opened`);

      return;
    }

    if (control.type === 'eof') {
      state.peerEof = true;

      stream.end();
    } else {
      state.unacked = Math.max(0, state.unacked - control.bytes);
      state.ackWaiter?.();
    }
  };

  const handleData = (data: Uint8Array): void => {
    const stream = state.stream;

    if (state.phase !== 'open' || stream === null || state.peerEof) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'data outside an open tunnel');

      return;
    }

    state.pendingAck += data.byteLength;

    if (data.byteLength > TUNNEL_MAX_FRAME_BYTES || state.pendingAck > MAX_PENDING_BYTES) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'past the window');

      return;
    }

    stream.write(data);

    if (!state.acking) {
      void sendPeerAcks(stream);
    }
  };

  return {
    handleMessage: (message) => {
      if (state.phase === 'closed') {
        return;
      }

      if (message instanceof Uint8Array) {
        handleData(message);
      } else {
        handleControl(message);
      }
    },
    handleClose: () => {
      if (state.phase === 'closed') {
        return;
      }

      state.phase = 'closed';
      state.stream?.close();
      state.listener?.close();
      state.release();
      state.ackWaiter?.();
    },
  };
}
