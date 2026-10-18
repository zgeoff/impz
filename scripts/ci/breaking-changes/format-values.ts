import { formatValue } from './format-value';

export function formatValues(values: readonly unknown[] | undefined): string {
  return values === undefined ? 'any' : values.map((value) => formatValue(value)).join(' | ');
}
