import type { RecordingStep } from './build-recording-operation';

export function buildRecordingStep(
  step: Partial<RecordingStep> & { readonly name: string },
): RecordingStep {
  return {
    onRestart: 'rerun',
    run: 'succeed',
    undo: 'none',
    writesUndo: false,
    result: null,
    writesEvent: null,
    writeFails: false,
    ...step,
  };
}
