import type { TunnelPeer } from '../../src/imps/tunnel/tunnel-session';

export function buildStubTunnelPeer() {
  const sent: unknown[] = [];
  const binary: string[] = [];
  const closed: { code: number | null; reason: string } = { code: null, reason: '' };

  const peer: TunnelPeer = {
    sendText: (text) => {
      sent.push(JSON.parse(text));
    },
    sendBinary: (data) => {
      binary.push(new TextDecoder().decode(data));
    },
    close: (code, reason) => {
      closed.code = code;
      closed.reason = reason;
    },
  };

  return { peer, sent, binary, closed };
}
