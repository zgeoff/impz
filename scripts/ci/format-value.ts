export function formatValue(value: unknown): string {
  return value === undefined ? 'none' : JSON.stringify(value);
}

export function formatValues(values: readonly unknown[] | undefined): string {
  return values === undefined ? 'any' : values.map((value) => formatValue(value)).join(' | ');
}
