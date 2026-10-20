// Runs `tick` every `ms` until the returned stop is called: the timer behind
// a call's progress and an event stream's keepalive. A test passes one it
// steps itself.
export type Repeat = (durationMs: number, tick: () => void) => () => void;

export function runOnInterval(durationMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, durationMs);

  return () => {
    clearInterval(timer);
  };
}
