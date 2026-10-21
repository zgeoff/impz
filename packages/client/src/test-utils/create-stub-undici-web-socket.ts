import { onTestFinished } from 'bun:test';

export function createStubUndiciWebSocket(url: string): WebSocket {
  const socket = new WebSocket(url);

  onTestFinished(() => {
    socket.close();
  });

  const listen = socket.addEventListener.bind(socket);

  Object.defineProperty(socket, 'addEventListener', {
    value: (type: string, listener: EventListener) => {
      // Node's undici WebSocket fires `error` and no `close` for a refused upgrade.
      if (type !== 'close') {
        listen(type, listener);
      }
    },
  });

  return socket;
}
