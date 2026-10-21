import { createHmac } from 'node:crypto';

export function sign(key: string | Uint8Array, text: string): Buffer {
  return createHmac('sha256', key).update(text).digest();
}
