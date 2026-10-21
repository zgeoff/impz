export function formatDuration(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60_000);

  if (minutes < 1) {
    return `${String(Math.floor(durationMs / 1000))}s`;
  }

  if (minutes < 60) {
    return `${String(minutes)}m`;
  }

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
