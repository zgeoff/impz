import type { StubAnswer, StubRun } from '../vm/build-stub-guest';

interface StubEngineOptions {
  readonly refusals: number;
  readonly answer: StubAnswer;
}

// A builder's engine refuses `docker info` until dockerd listens, as a freshly booted guest does.
export function makeStubEngineAnswer(options: Readonly<StubEngineOptions>) {
  const state = { infos: 0 };

  return (run: StubRun): StubAnswer => {
    if (run.argv[0] !== 'docker' || run.argv[1] !== 'info') {
      return options.answer;
    }

    state.infos += 1;

    return state.infos <= options.refusals
      ? { code: 1, stderr: 'Cannot connect to the Docker daemon' }
      : {};
  };
}
