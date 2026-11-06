import { expect, test } from 'bun:test';
import { defineOperation } from './define-operation';

test('it keeps the steps in the order the definition lists them', () => {
  const shelf = defineOperation({
    kind: 'shelf.build',
    parseParams: () => ({ label: 'oak' }),
    steps: {
      measure: { onRestart: 'rerun', run: () => Promise.resolve({}) },
      cut: { onRestart: 'fail', run: () => Promise.resolve({}) },
    },
  });

  expect(shelf.steps.map((step) => [step.name, step.onRestart])).toStrictEqual([
    ['measure', 'rerun'],
    ['cut', 'fail'],
  ]);
});

test('it hands each step the params its parser returns', async () => {
  const seen: unknown[] = [];

  const shelf = defineOperation({
    kind: 'shelf.build',
    parseParams: (value) => ({ label: String(value) }),
    steps: {
      cut: {
        onRestart: 'rerun',
        run: (ctx) => {
          seen.push(ctx.params);

          return Promise.resolve({});
        },
      },
    },
  });

  await shelf.steps[0]?.run({
    operationId: 'op-1',
    targetId: null,
    params: 'oak',
    signal: new AbortController().signal,
    undoRecord: null,
    writeUndo: () => Promise.resolve(),
  });

  expect(seen).toStrictEqual([{ label: 'oak' }]);
});

test('it gives a step with no undo a null undo', () => {
  const shelf = defineOperation({
    kind: 'shelf.build',
    parseParams: () => ({ label: 'oak' }),
    steps: { cut: { onRestart: 'rerun', run: () => Promise.resolve({}) } },
  });

  expect(shelf.steps[0]?.undo).toBeNull();
});
