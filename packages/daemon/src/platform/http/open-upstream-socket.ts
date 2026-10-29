import invariant from 'tiny-invariant';
import type { StartTimer } from '../process/clock';

interface OpenOptions {
  readonly timeoutMs: number;
  readonly startTimer: StartTimer;

  readonly ca?: readonly string[];
}

export function openUpstreamSocket(
  target: string,
  protocols: readonly string[],
  headers: Readonly<Headers>,
  options: Readonly<OpenOptions>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socketOptions: Bun.WebSocketOptions = {
      protocols: [...protocols],
      headers: Object.fromEntries(headers),
      ...(options.ca !== undefined && { tls: { ca: [...options.ca] } }),
    };

    // Bun's WebSocket takes headers in an options object. bun-types defer to
    // lib.dom's constructor, which takes none, when lib.dom is loaded, as it is
    // in the dashboard's type check, which reads this module.
    const socket: unknown = Reflect.construct(WebSocket, [target, socketOptions]);

    invariant(socket instanceof WebSocket);

    socket.binaryType = 'arraybuffer';

    const cancelTimer = options.startTimer(() => {
      socket.close();

      reject(new Error('timed out'));
    }, options.timeoutMs);

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
