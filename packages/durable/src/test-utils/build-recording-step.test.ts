import { expect, test } from 'bun:test';
import { buildRecordingStep } from './build-recording-step';

test('it builds a step that reruns, succeeds and has no undo', () => {
  const step = buildRecordingStep({ name: 'measure' });

  expect(step).toStrictEqual({
    name: 'measure',
    onRestart: 'rerun',
    run: 'succeed',
    undo: 'none',
    writesUndo: false,
    result: null,
    writesEvent: null,
    writeFails: false,
  });
});

test('it keeps the fields the caller gives', () => {
  const step = buildRecordingStep({ name: 'cut', onRestart: 'fail', undo: 'succeed' });

  expect(step).toStrictEqual(expect.objectContaining({ onRestart: 'fail', undo: 'succeed' }));
});
