import { ElysiaWS } from 'elysia/ws';
import type { ServerWebSocket, WSConnectionData } from 'elysia/ws';
import invariant from 'tiny-invariant';

// Elysia's socket type leaves out the Bun socket under it. Elysia's own close
// runs the route's close hook before Bun's close event, and its send encodes
// the frame, so impd writes to the Bun socket.
export function getRawSocket(ws: object): ServerWebSocket<WSConnectionData> {
  invariant(ws instanceof ElysiaWS, 'a WebSocket hook got a socket that Elysia did not wrap');

  return ws.raw;
}
