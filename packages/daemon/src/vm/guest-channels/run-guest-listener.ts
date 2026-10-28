import type { GuestListener } from '../agent-client/listener-stream';

export const MAX_RELAYS_PER_FORWARD = 64;

export interface GuestListenerHandlers {
  readonly deliver: (id: number) => Promise<void>;
  readonly refuse: (id: number) => Promise<void>;
  readonly isFull: () => boolean;
}

export async function runGuestListener(
  listener: GuestListener,
  handlers: GuestListenerHandlers,
): Promise<void> {
  for await (const id of listener.connections()) {
    void (handlers.isFull() ? handlers.refuse(id) : handlers.deliver(id));
  }
}
