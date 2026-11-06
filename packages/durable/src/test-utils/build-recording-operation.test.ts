import { expect, test } from 'bun:test';
import { buildRecordingOperation } from './build-recording-operation';
import { buildRecordingStep } from './build-recording-step';

function setupTest() {
  const controller = new AbortController();

  const undoRecords: unknown[] = [];

  return {
    controller,
    undoRecords,
    step: {
      operationId: 'op-1',
      targetId: 'shelf-1',
      params: { label: 'oak' },
      signal: controller.signal,
      undoRecord: null,
      writeUndo: (record: unknown) => {
        undoRecords.push(record);

        return Promise.resolve();
      },
    },
  };
}

test('it records the step’s name after its effect', async () => {
  const ctx = setupTest();
  const effects: string[] = [];

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'measure' })],
    effects,
  );

  await operation.steps[0]?.run(ctx.step);

  expect(effects).toStrictEqual(['measure']);
});

test('it returns the step’s result', async () => {
  const ctx = setupTest();

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'measure', result: { widthCm: 80 } })],
    [],
  );

  const output = await operation.steps[0]?.run(ctx.step);

  expect(output).toStrictEqual({ result: { widthCm: 80 } });
});

test('it writes the undo record before the effect', async () => {
  const ctx = setupTest();

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', writesUndo: true, run: 'fail' })],
    [],
  );

  await operation.steps[0]?.run(ctx.step).catch(() => {});

  expect(ctx.undoRecords).toStrictEqual([{ step: 'cut', label: 'oak' }]);
});

test('it throws from a failing step without recording an effect', async () => {
  const ctx = setupTest();
  const effects: string[] = [];

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', run: 'fail' })],
    effects,
  );

  const run = operation.steps[0]?.run(ctx.step);

  await run?.catch(() => {});

  expect(run).rejects.toThrowWithMessage(Error, /cut failed/u);
  expect(effects).toStrictEqual([]);
});

test('it ends a waiting step with an error once the signal aborts', () => {
  const ctx = setupTest();

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', run: 'wait-for-cancel' })],
    [],
  );

  const run = operation.steps[0]?.run(ctx.step);

  ctx.controller.abort();

  expect(run).rejects.toThrowWithMessage(Error, /cut saw the cancel/u);
});

test('it records the effect of a hung step, which never returns', () => {
  const ctx = setupTest();
  const effects: string[] = [];

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', run: 'hang' })],
    effects,
  );

  void operation.steps[0]?.run(ctx.step);
  expect(effects).toStrictEqual(['cut']);
});

test('it records an undo as undo and the step’s name', async () => {
  const effects: string[] = [];

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', undo: 'succeed' })],
    effects,
  );

  await operation.steps[0]?.undo?.({
    operationId: 'op-1',
    targetId: null,
    params: { label: 'oak' },
    undoRecord: null,
  });

  expect(effects).toStrictEqual(['undo cut']);
});

test('it records the effect of a hung undo, which never returns', () => {
  const effects: string[] = [];

  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', undo: 'hang' })],
    effects,
  );

  void operation.steps[0]?.undo?.({
    operationId: 'op-1',
    targetId: null,
    params: { label: 'oak' },
    undoRecord: null,
  });

  expect(effects).toStrictEqual(['undo cut']);
});

test('it throws from a failing undo', () => {
  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', undo: 'fail' })],
    [],
  );

  const undo = operation.steps[0]?.undo?.({
    operationId: 'op-1',
    targetId: null,
    params: { label: 'oak' },
    undoRecord: null,
  });

  expect(undo).rejects.toThrowWithMessage(Error, /the undo of cut failed/u);
});

test('it refuses params without a label', () => {
  const operation = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut' })],
    [],
  );

  expect(() => operation.parseParams({ width: 2 })).toThrowWithMessage(Error, /have no label/u);
});
