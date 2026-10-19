import type { StartTimer } from '../process/clock';

// how long an upstream WebSocket may take to open, and the timer that waits
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
    const socket = new WebSocket(target, {
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
