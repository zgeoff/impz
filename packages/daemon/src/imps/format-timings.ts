export function formatTimings(timings: Readonly<Record<string, number>>): string {
  return Object.entries(timings)
    .map(([step, durationMs]) => `${step}=${String(durationMs)}ms`)
    .join(' ');
}
