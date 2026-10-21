import type { StartTimer } from '../../platform/process/clock';

interface OpenDeadline {
  readonly timeoutMs: number;
  readonly startTimer: StartTimer;
}

// Bun's WebSocket takes headers in an options object. bun-types defer to
// lib.dom's constructor, which takes none, when lib.dom is loaded, as it is in
// the dashboard's type check, which reads this module.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

export function openUpstreamSocket(
  target: string,
  protocols: readonly string[],
  headers: Readonly<Headers>,
  deadline: Readonly<OpenDeadline>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new BunWebSocket(target, {
      protocols: [...protocols],
      headers: Object.fromEntries(headers),
    });

    socket.binaryType = 'arraybuffer';

    const cancelTimer = deadline.startTimer(() => {
      socket.close();

      reject(new Error('timed out'));
    }, deadline.timeoutMs);

    socket.addEventListener('open', () => {
      cancelTimer();
      resolve(socket);
    });

    socket.addEventListener('error', () => {
      cancelTimer();
      reject(new Error('connection failed'));
    });
  });
}
