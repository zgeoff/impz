import { expect, test } from 'bun:test';
import { MOVE_PATHS } from '../../src/imp-ops/moves/move-header';
import { buildStubOverlappingMove } from './build-stub-overlapping-move';
import { TARGET_URL, setupMoveHosts } from './create-move-hosts';

function setupTest() {
  return setupMoveHosts();
}

test('it forwards a stream part with no other move until it is armed', async () => {
  const ctx = await setupTest();

  const steps: string[] = [];
  const stub = buildStubOverlappingMove();

  await stub.hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, { method: 'POST' }),
    () => {
      steps.push('forward');

      return Promise.resolve(new Response(null));
    },
    ctx,
  );

  expect(steps).toStrictEqual(['forward']);
});

test('it runs the other move it was armed with before it forwards the next stream part', async () => {
  const ctx = await setupTest();

  const steps: string[] = [];
  const stub = buildStubOverlappingMove();

  stub.arm(() => {
    steps.push('other move');

    return Promise.resolve();
  });

  await stub.hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, { method: 'POST' }),
    () => {
      steps.push('forward');

      return Promise.resolve(new Response(null));
    },
    ctx,
  );

  expect(steps).toStrictEqual(['other move', 'forward']);
});

test('it forwards an offer without the other move it was armed with', async () => {
  const ctx = await setupTest();

  const steps: string[] = [];
  const stub = buildStubOverlappingMove();

  stub.arm(() => {
    steps.push('other move');

    return Promise.resolve();
  });

  await stub.hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.offer}`, { method: 'POST' }),
    () => {
      steps.push('forward');

      return Promise.resolve(new Response(null));
    },
    ctx,
  );

  expect(steps).toStrictEqual(['forward']);
});

test('it runs the other move once, for the first stream part after it is armed', async () => {
  const ctx = await setupTest();

  const steps: string[] = [];
  const stub = buildStubOverlappingMove();

  const forward = () => {
    steps.push('forward');

    return Promise.resolve(new Response(null));
  };

  stub.arm(() => {
    steps.push('other move');

    return Promise.resolve();
  });

  await stub.hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, { method: 'POST' }),
    forward,
    ctx,
  );

  await stub.hook(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, { method: 'POST' }),
    forward,
    ctx,
  );

  expect(steps).toStrictEqual(['other move', 'forward', 'forward']);
});
