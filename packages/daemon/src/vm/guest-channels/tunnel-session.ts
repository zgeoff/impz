import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
  TunnelClientMessageSchema,
} from '@impz/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@impz/api';
import { match } from 'ts-pattern';
import { ImpdError } from '../../platform/errors/impd-error';
import { createCountedLimit } from '../../platform/process/counted-limit';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import { buildGuestFailure } from './build-guest-failure';
import { createAckSender } from './create-ack-sender';
import { createAckWindow } from './create-ack-window';
import type { ReverseForwards } from './reverse-forwards';
import { runGuestListener } from './run-guest-listener';
import { stopGuestClient } from './stop-guest-client';

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

type TunnelStart = Extract<TunnelClientMessage, { type: 'open' | 'listen' | 'accept' }>;

export interface TunnelLimits {
  readonly max: number;
  readonly tryOpen: (impId: string) => (() => void) | null;
}

export function createTunnelLimits(max = MAX_TUNNELS_PER_IMP): TunnelLimits {
  const counts = createCountedLimit(max);

  return { max, tryOpen: counts.tryClaim };
}

function buildErrorMessage(error: unknown): TunnelServerMessage {
  const failure = buildGuestFailure(error);

  return {
    type: 'error',
    ...(failure.code !== undefined && { code: failure.code }),
    message: failure.message,
  };
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
    guestEof: boolean;
    peerEof: boolean;
  } = {
    phase: 'waiting',
    stream: null,
    listener: null,
    release: () => {},
    guestEof: false,
    peerEof: false,
  };

  const send = (message: TunnelServerMessage): void => {
    peer.sendText(JSON.stringify(message));
  };

  const isOpen = (): boolean => state.phase === 'open';
  const outputWindow = createAckWindow(TUNNEL_WINDOW_BYTES, isOpen);

  const peerAcks = createAckSender(isOpen, (bytes) => {
    send({ type: 'ack', bytes });
  });

  const stopTunnel = (code: number, reason: string): void => {
    if (state.phase === 'closed') {
      return;
    }

    state.phase = 'closed';
    state.stream?.close();
    state.listener?.close();
    state.release();
    outputWindow.stop();
    peer.close(code, reason);
  };

  const stopWithError = (error: unknown): void => {
    if (state.phase === 'closed') {
      return;
    }

    send(buildErrorMessage(error));
    stopTunnel(TUNNEL_CLOSE_NORMAL, 'tunnel failed');
  };

  const sendGuestOutput = async (stream: DialStream): Promise<void> => {
    for await (const event of stream.events()) {
      if (event.type === 'eof') {
        state.guestEof = true;

        send({ type: 'eof' });
        continue;
      }

      await outputWindow.waitForRoom();

      if (state.phase !== 'open') {
        return;
      }

      peer.sendBinary(event.data);
      outputWindow.countSent(event.data.byteLength);
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

  const runForward = async (name: string, listener: GuestListener): Promise<void> => {
    try {
      await runGuestListener(listener, {
        deliver: (id) => {
          send({ type: 'connection', id });

          return Promise.resolve();
        },
        refuse: (id) => stopGuestClient(() => backend.openAccept(name, listener.id, id)),
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
      startTunnel(control);

      return;
    }

    const stream = state.stream;

    if (state.phase !== 'open' || stream === null) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, `${control.type} before opened`);

      return;
    }

    match(control)
      .with({ type: 'eof' }, () => {
        state.peerEof = true;

        stream.end();
      })
      .with({ type: 'ack' }, (ack) => {
        outputWindow.countAcked(ack.bytes);
      })
      .exhaustive();
  };

  const startTunnel = (control: TunnelStart): void => {
    if (state.phase !== 'waiting') {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, `${control.type} after the start`);

      return;
    }

    match(control)
      .with({ type: 'open' }, (open) => {
        const target: DialTarget = { network: 'tcp', address: `127.0.0.1:${String(open.port)}` };

        void openTunnel(
          open.name,
          (impId) => allocateTunnel(open.name, impId),
          () => backend.openDial(open.name, target),
        );
      })
      .with({ type: 'accept' }, (accept) => {
        void openTunnel(
          accept.name,
          (impId) => allocateRelay(accept.name, accept.listener, impId),
          () => backend.openAccept(accept.name, accept.listener, accept.connection),
        );
      })
      .with({ type: 'listen' }, (listen) => {
        void openForward(listen);
      })
      .exhaustive();
  };

  const handleData = (data: Uint8Array): void => {
    const stream = state.stream;

    if (state.phase !== 'open' || stream === null || state.peerEof) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'data outside an open tunnel');

      return;
    }

    const pending = peerAcks.countReceived(data.byteLength);

    if (data.byteLength > TUNNEL_MAX_FRAME_BYTES || pending > MAX_PENDING_BYTES) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'past the window');

      return;
    }

    stream.write(data);
    peerAcks.sendAcks(() => stream.drained());
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
      outputWindow.stop();
    },
  };
}
