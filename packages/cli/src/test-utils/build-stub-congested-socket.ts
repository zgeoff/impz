import type { ExecSocket } from '@impz/client';

export function buildStubCongestedSocket(ws: WebSocket) {
  const queued = { bytes: 0 };

  const socket: ExecSocket = {
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(type) {
      ws.binaryType = type;
    },
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      return queued.bytes;
    },
    send: (data) => {
      ws.send(data);
    },
    close: (code, reason) => {
      ws.close(code, reason);
    },
    addEventListener: ws.addEventListener.bind(ws),
  };

  return { socket, queued };
}
