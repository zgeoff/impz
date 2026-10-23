export interface BuildOutput {
  readonly emitLog: (line: string) => void;
  readonly setStep: (step: string) => void;
}

// BuildKit names a Dockerfile step's vertex `[2/5] RUN make`, or `[builder 2/5] RUN make` in a
// multi-stage build, and its own vertexes `[internal] load …`.
const STEP_PATTERN = /^\[(?:\S+ )?\d+\/\d+\] /v;

export interface BuildSteps {
  readonly start: (id: string, name: string) => void;

  readonly end: (id: string) => void;
}

export function createBuildSteps(setStep: (step: string) => void): BuildSteps {
  const running = new Map<string, string>();

  const state = { current: null as string | null };

  return {
    start: (id, name) => {
      if (!STEP_PATTERN.test(name)) {
        return;
      }

      running.delete(id);
      running.set(id, name);

      state.current = id;

      setStep(name);
    },
    end: (id) => {
      if (!running.delete(id) || state.current !== id) {
        return;
      }

      const last = [...running].at(-1);

      state.current = last?.[0] ?? null;

      if (last !== undefined) {
        setStep(last[1]);
      }
    },
  };
}
