import { TunnelServerMessageSchema } from '@impz/api';
import type { TunnelServerMessage } from '@impz/api';

export function parseTunnelServerMessage(text: string): TunnelServerMessage | null {
  try {
    const parsed = TunnelServerMessageSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
