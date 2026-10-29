import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { sendOrClose } from '../../../platform/http/send-or-close';
import { toSendableCloseCode } from '../../../platform/http/to-sendable-close-code';
import type { ConnectionAudit } from './plan-upgrade';

export interface RelayData {
  readonly upstream: WebSocket;
  readonly pending: (string | ArrayBuffer)[];
  readonly handleEarlyMessage: (event: MessageEvent<string | ArrayBuffer>) => void;
  readonly audit: ConnectionAudit;
  readonly untrack: () => void;

  readonly guest: { socket: ServerWebSocket<RelayData> | null };
}

export const RELAY_SOCKET_HANDLER: WebSocketHandler<RelayData> = {
  open: (ws) => {
    const data = ws.data;

    data.guest.socket = ws;

    data.upstream.removeEventListener('message', data.handleEarlyMessage);

    for (const message of data.pending.splice(0)) {
      data.audit.addResponseBytes(measureMessage(message));

      sendOrClose(ws, message);
    }

    data.upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      data.audit.addResponseBytes(measureMessage(event.data));

      sendOrClose(ws, event.data);
    });

    // no close can come earlier: Bun runs `open` inside server.upgrade, in the
    // same task as the upstream's open event
    data.upstream.addEventListener('close', (event) => {
      ws.close(toSendableCloseCode(event.code), event.reason);
    });
  },
  message: (ws, message) => {
    ws.data.audit.addRequestBytes(measureMessage(message));
    ws.data.upstream.send(message);
  },
  close: (ws, code, reason) => {
    ws.data.untrack();
    ws.data.audit.recordClose();

    if (ws.data.upstream.readyState <= WebSocket.OPEN) {
      ws.data.upstream.close(toSendableCloseCode(code), reason);
    }
  },
};

function measureMessage(message: string | ArrayBuffer | Uint8Array): number {
  return typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
}
