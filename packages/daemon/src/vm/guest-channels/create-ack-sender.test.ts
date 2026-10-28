import { expect, mock, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import { createAckSender } from './create-ack-sender';

test('it counts the bytes received and not yet acked', () => {
  const acks = createAckSender(
    () => true,
    () => {},
  );

  acks.countReceived(4);

  expect(acks.countReceived(6)).toBe(10);
});

test('it acks the received bytes once the guest drains them', async () => {
  const sendAck = mock<(bytes: number) => void>();
  const acks = createAckSender(() => true, sendAck);
  const drain = Promise.withResolvers<void>();

  acks.countReceived(7);
  acks.sendAcks(() => drain.promise);
  drain.resolve();

  await waitFor(() => {
    expect(sendAck).toHaveBeenCalledExactlyOnceWith(7);
  });
});

test('it sends no ack before the guest drains the bytes', async () => {
  const sendAck = mock<(bytes: number) => void>();
  const acks = createAckSender(() => true, sendAck);

  acks.countReceived(7);
  acks.sendAcks(() => Promise.withResolvers<void>().promise);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(sendAck).not.toHaveBeenCalled();
});

test('it sends no ack once the channel closes', async () => {
  const channel = { open: true };
  const sendAck = mock<(bytes: number) => void>();
  const acks = createAckSender(() => channel.open, sendAck);
  const drain = Promise.withResolvers<void>();

  acks.countReceived(7);
  acks.sendAcks(() => drain.promise);

  channel.open = false;

  drain.resolve();

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(sendAck).not.toHaveBeenCalled();
});
