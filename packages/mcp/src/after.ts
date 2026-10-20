// Runs `fire` once after `ms`, unless the returned cancel runs first: the
// timer behind a command's deadline and its kill grace. A test passes one it
// fires itself.
export type After = (durationMs: number, fire: () => void) => () => void;

export function runAfter(durationMs: number, fire: () => void): () => void {
  const timer = setTimeout(fire, durationMs);

  return () => {
    clearTimeout(timer);
  };
}
