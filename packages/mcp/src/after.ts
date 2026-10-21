export type After = (durationMs: number, fire: () => void) => () => void;

export function runAfter(durationMs: number, fire: () => void): () => void {
  const timer = setTimeout(fire, durationMs);

  return () => {
    clearTimeout(timer);
  };
}
