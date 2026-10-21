import invariant from 'tiny-invariant';
import type { StartTimer } from '../../platform/process/clock';

interface OpenDeadline {
  readonly timeoutMs: number;
  readonly startTimer: StartTimer;
}

export function openUpstreamSocket(
  target: string,
  protocols: readonly string[],
  headers: Readonly<Headers>,
  deadline: Readonly<OpenDeadline>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const options: Bun.WebSocketOptions = {
      protocols: [...protocols],
      headers: Object.fromEntries(headers),
    };

    // Bun's WebSocket takes headers in an options object. bun-types defer to
    // lib.dom's constructor, which takes none, when lib.dom is loaded, as it is
    // in the dashboard's type check, which reads this module.
    const socket: unknown = Reflect.construct(WebSocket, [target, options]);

    invariant(socket instanceof WebSocket);

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
