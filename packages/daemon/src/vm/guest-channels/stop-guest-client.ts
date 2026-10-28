import type { DialStream } from '../agent-client/dial-stream';

export async function stopGuestClient(openAccept: () => Promise<DialStream>): Promise<void> {
  try {
    const stream = await openAccept();

    stream.close();
  } catch {}
}
