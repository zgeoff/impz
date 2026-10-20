// Runs `run` every `ms` on a real interval; the returned function stops it.
export function startInterval(run: () => void, durationMs: number): () => void {
  const timer = setInterval(run, durationMs);

  return () => {
    clearInterval(timer);
  };
}
