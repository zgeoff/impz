import { expect, test } from 'bun:test';
import { buildStubDialStream } from '../../../testing/vm/build-stub-dial-stream';
import { stopGuestClient } from './stop-guest-client';

test('it accepts the guest client and closes it at once', async () => {
  const stub = buildStubDialStream();

  await stopGuestClient(() => Promise.resolve(stub.stream));

  expect(stub.state.isClosed).toBe(true);
});

test('it ignores a client that the guest has already dropped', async () => {
  const dropped = Promise.reject(new Error('no such connection'));

  await expect(stopGuestClient(() => dropped)).toResolve();
});
