export function startInterval(run: () => void, durationMs: number): () => void {
  const timer = setInterval(run, durationMs);

  return () => {
    clearInterval(timer);
  };
}
