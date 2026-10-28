import { expect, mock, test } from 'bun:test';
import { MOVE_PART_HEADER } from '../../src/imp-ops/moves/move-header';
import { TARGET_URL, setupMoveHosts } from './create-move-hosts';
import { makeStubStalledMovePart } from './make-stub-stalled-move-part';

function setupTest() {
  return setupMoveHosts();
}

test('it holds the first part unanswered until the source aborts its request', async () => {
  const ctx = await setupTest();

  const onStalled = mock(() => {});

  const controller = new AbortController();

  const sent = makeStubStalledMovePart(onStalled)(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: { [MOVE_PART_HEADER]: '0' },
      signal: controller.signal,
    }),
    () => Promise.resolve(new Response(null, { status: 204 })),
    ctx,
  );

  controller.abort(new Error('the source gave up on the part'));

  expect(sent).rejects.toThrowWithMessage(Error, 'the source gave up on the part');
  expect(onStalled).toHaveBeenCalledOnce();
});

test('it forwards a later part as sent', async () => {
  const ctx = await setupTest();

  const onStalled = mock(() => {});

  const response = await makeStubStalledMovePart(onStalled)(
    new Request(`${TARGET_URL}/move/receive`, {
      method: 'POST',
      headers: { [MOVE_PART_HEADER]: '1' },
    }),
    () => Promise.resolve(new Response(null, { status: 204 })),
    ctx,
  );

  expect(response.status).toBe(204);
  expect(onStalled).not.toHaveBeenCalled();
});
