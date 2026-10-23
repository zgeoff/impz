const FAILURE_MAX_CHARS = 4000;

export function formatFailureTail(output: string): string {
  return output.trim().slice(-FAILURE_MAX_CHARS);
}
