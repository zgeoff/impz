import type { ServerWebSocket } from 'bun';

// RFC 6455's try again later: the server cannot keep up with this connection
const FELL_BEHIND_CODE = 1013;

// Past the backpressure limit Bun's send drops the message and answers 0;
// closeOnBackpressureLimit left the broker's TLS sockets on a unix listener
// open and dropping, so the close is made here.
export function sendOrClose(
  socket: Pick<ServerWebSocket<unknown>, 'send' | 'close'>,
  message: string | ArrayBuffer | Uint8Array,
): void {
  if (socket.send(message) === 0) {
    socket.close(FELL_BEHIND_CODE, 'the client fell behind');
  }
}
