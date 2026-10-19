export function formatValue(value: unknown): string {
  return value === undefined ? 'none' : JSON.stringify(value);
}
