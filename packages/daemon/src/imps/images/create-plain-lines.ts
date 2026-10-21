import { IMAGE_BUILD_LOG_MAX_CHARS } from '@impz/api';
import { createBuildSteps } from './create-build-steps';
import type { BuildOutput } from './create-build-steps';

// In `docker build --progress=plain` output, `#3 [2/5] RUN make` starts vertex 3, and
// `#3 DONE 0.4s`, `#3 CACHED` or `#3 ERROR: …` ends it.
const VERTEX_LINE = /^#(?<id>\d+) (?<rest>.*)$/v;
const VERTEX_END = /^(?:DONE|CACHED|ERROR)\b/v;

export interface PlainLines {
  readonly readChunk: (chunk: Uint8Array) => void;

  readonly flush: () => void;
}

export function createPlainLines(output: BuildOutput): PlainLines {
  const steps = createBuildSteps(output.setStep);

  const decoder = new TextDecoder();

  const state = { partial: '' };

  const readLine = (line: string): void => {
    output.emitLog(line.slice(0, IMAGE_BUILD_LOG_MAX_CHARS));

    const match = VERTEX_LINE.exec(line);
    const id = match?.groups?.['id'];
    const rest = match?.groups?.['rest'];

    if (id === undefined || rest === undefined) {
      return;
    }

    if (VERTEX_END.test(rest)) {
      steps.end(id);
    } else {
      steps.start(id, rest);
    }
  };

  const readChunk = (chunk: Uint8Array): void => {
    const lines = (state.partial + decoder.decode(chunk, { stream: true })).split(/\r?\n/v);

    state.partial = lines.pop() ?? '';

    for (const line of lines) {
      readLine(line);
    }

    while (state.partial.length > IMAGE_BUILD_LOG_MAX_CHARS) {
      output.emitLog(state.partial.slice(0, IMAGE_BUILD_LOG_MAX_CHARS));

      state.partial = state.partial.slice(IMAGE_BUILD_LOG_MAX_CHARS);
    }
  };

  return {
    readChunk,
    flush: () => {
      const line = state.partial + decoder.decode();

      state.partial = '';

      if (line !== '') {
        readLine(line);
      }
    },
  };
}
