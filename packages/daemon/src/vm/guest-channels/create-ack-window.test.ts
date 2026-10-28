import { expect, test } from 'bun:test';
import { createAckWindow } from './create-ack-window';

test('it lets a send through while the unacked bytes fit the window', async () => {
  const window = createAckWindow(10, () => true);

  window.countSent(10);

  await expect(window.waitForRoom()).toResolve();
});

test('it holds a send past the window while the unacked bytes still overflow it', async () => {
  const window = createAckWindow(10, () => true);

  window.countSent(15);

  const waiting = window.waitForRoom();

  window.countAcked(2);

  const first = await Promise.race([
    waiting.then(() => 'room'),
    new Promise<string>((resolve) => {
      setImmediate(resolve, 'held');
    }),
  ]);

  expect(first).toBe('held');
});

test('it lets a held send through once the peer acks enough bytes', async () => {
  const window = createAckWindow(10, () => true);

  window.countSent(15);

  const waiting = window.waitForRoom();

  window.countAcked(5);

  await expect(waiting).toResolve();
});

test('it ends a wait when the channel stops', async () => {
  const channel = { open: true };
  const window = createAckWindow(10, () => channel.open);

  window.countSent(50);

  const waiting = window.waitForRoom();

  channel.open = false;

  window.stop();

  await expect(waiting).toResolve();
});
