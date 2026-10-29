import { expect, mock, test } from 'bun:test';
import { sendOrClose } from './send-or-close';

test('it sends a message and leaves the socket open', () => {
  const close = mock();

  sendOrClose({ send: () => 5, close }, 'hello');

  expect(close).not.toHaveBeenCalled();
});

test('it leaves open a socket that queued the message under backpressure', () => {
  const close = mock();

  sendOrClose({ send: () => -1, close }, 'hello');

  expect(close).not.toHaveBeenCalled();
});

test('it closes a socket that dropped the message with 1013', () => {
  const close = mock();

  sendOrClose({ send: () => 0, close }, 'hello');

  expect(close).toHaveBeenCalledExactlyOnceWith(1013, 'the client fell behind');
});
