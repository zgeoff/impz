export function splitLines(): TransformStream<string, string> {
  const state = { pending: '' };

  return new TransformStream<string, string>({
    transform: (chunk, controller) => {
      const lines = `${state.pending}${chunk}`.split('\n');

      state.pending = lines.pop() ?? '';

      for (const line of lines) {
        controller.enqueue(line);
      }
    },
    flush: (controller) => {
      if (state.pending !== '') {
        controller.enqueue(state.pending);
      }
    },
  });
}
