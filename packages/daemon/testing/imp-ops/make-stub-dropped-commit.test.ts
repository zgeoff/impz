import { expect, test } from 'bun:test';
import { MOVE_PATHS } from '../../src/imp-ops/moves/move-header';
import { TARGET_URL, setupMoveHosts } from './create-move-hosts';
import { makeStubDroppedCommit } from './make-stub-dropped-commit';

function setupTest() {
  return setupMoveHosts();
}

test('it rejects the first commit before it reaches the target', async () => {
  const ctx = await setupTest();

  const forwarded: string[] = [];

  const sent = makeStubDroppedCommit()(
    new Request(`${TARGET_URL}${MOVE_PATHS.commit}`, { method: 'POST' }),
    () => {
      forwarded.push('commit');

      return Promise.resolve(Response.json({ isCommitted: true }));
    },
    ctx,
  );

  expect(sent).rejects.toThrowWithMessage(Error, 'the network dropped the commit');
  expect(forwarded).toStrictEqual([]);
});

test('it lets a commit through once it dropped as many as it was told', async () => {
  const ctx = await setupTest();

  const hook = makeStubDroppedCommit({ count: 2 });

  const first = hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.commit}`),
    () => Promise.resolve(new Response(null)),
    ctx,
  );

  const second = hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.commit}`),
    () => Promise.resolve(new Response(null)),
    ctx,
  );

  await Promise.allSettled([first, second]);

  const third = await hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.commit}`),
    () => Promise.resolve(Response.json({ isCommitted: true })),
    ctx,
  );

  expect(third.status).toBe(200);
});

test('it lets the commit reach the target and drops its answer when told to', async () => {
  const ctx = await setupTest();

  const forwarded: string[] = [];

  const sent = makeStubDroppedCommit({ drops: 'answer' })(
    new Request(`${TARGET_URL}${MOVE_PATHS.commit}`, { method: 'POST' }),
    () => {
      forwarded.push('commit');

      return Promise.resolve(Response.json({ isCommitted: true }));
    },
    ctx,
  );

  expect(sent).rejects.toThrowWithMessage(Error, 'the network dropped the answer');
  expect(forwarded).toStrictEqual(['commit']);
});

test('it forwards a request to another route as sent', async () => {
  const ctx = await setupTest();

  const response = await makeStubDroppedCommit()(
    new Request(`${TARGET_URL}${MOVE_PATHS.offer}`, { method: 'POST' }),
    () => Promise.resolve(new Response(null, { status: 204 })),
    ctx,
  );

  expect(response.status).toBe(204);
});
