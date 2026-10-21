import { decodeExecFrame } from '@impz/api';
import type { ExecPeer } from '../../src/imps/exec/exec-session';

interface StubExecSocketOptions {
  readonly keeps?: number;
}

export function buildStubExecSocket(options: StubExecSocketOptions = {}) {
  const keeps = options.keeps ?? Infinity;
  const sent: unknown[] = [];
  const closes: number[] = [];
  const closeReasons: (string | undefined)[] = [];
  const binary = { count: 0 };
  const buffered = { bytes: 0, reads: 0 };

  const peer: ExecPeer = {
    sendText: (text) => {
      sent.push(JSON.parse(text));
    },
    sendBinary: (data) => {
      binary.count += 1;

      if (binary.count > keeps) {
        return false;
      }

      const frame = decodeExecFrame(data);

      sent.push([frame.channel, new TextDecoder().decode(frame.data)]);

      return true;
    },
    close: (code, reason) => {
      closes.push(code ?? 1000);
      closeReasons.push(reason);
    },
    readBufferedAmount: () => {
      buffered.reads += 1;

      return buffered.bytes;
    },
  };

  return { peer, sent, closes, closeReasons, buffered };
}
