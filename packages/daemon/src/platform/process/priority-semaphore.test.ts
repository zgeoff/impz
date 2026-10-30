import { expect, test } from 'bun:test';
import { createPrioritySemaphore } from './priority-semaphore';

test('it gives a free slot to a waiting foreground task before an older background one', async () => {
  const semaphore = createPrioritySemaphore(1);
  const held = Promise.withResolvers<undefined>();
  const order: string[] = [];
  const holding = semaphore.run('background', () => held.promise);

  const background = semaphore.run('background', () => {
    order.push('background');

    return Promise.resolve();
  });

  const foreground = semaphore.run('foreground', () => {
    order.push('foreground');

    return Promise.resolve();
  });

  held.resolve(undefined);

  await Promise.all([holding, background, foreground]);

  expect(order).toStrictEqual(['foreground', 'background']);
});

test('it frees the slot when a task fails, so the next one runs', async () => {
  const semaphore = createPrioritySemaphore(1);
  const failing = semaphore.run('foreground', () => Promise.reject(new Error('refused')));
  const next = semaphore.run('background', () => Promise.resolve('ran'));

  expect(failing).rejects.toThrow('refused');

  const ran = await next;

  expect(ran).toBe('ran');
});

test('it runs tasks up to its limit at once', async () => {
  const semaphore = createPrioritySemaphore(2);
  const held = Promise.withResolvers<undefined>();
  const started: string[] = [];

  const first = semaphore.run('background', async () => {
    started.push('first');

    await held.promise;
  });

  const second = semaphore.run('background', async () => {
    started.push('second');

    await held.promise;
  });

  await Promise.resolve();

  const startedBefore = [...started];

  held.resolve(undefined);

  await Promise.all([first, second]);

  expect(startedBefore).toStrictEqual(['first', 'second']);
});
