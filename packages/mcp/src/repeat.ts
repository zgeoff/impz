export type Repeat = (durationMs: number, tick: () => void) => () => void;

export function runOnInterval(durationMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, durationMs);

  return () => {
    clearInterval(timer);
  };
}
