import type { JsonValue } from './json-value';

export function toCanonicalJson(value: JsonValue): string {
  return JSON.stringify(toSortedValue(value));
}

function toSortedValue(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value.map((item) => toSortedValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, toSortedValue(value[key] ?? null)]),
    );
  }

  return value;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
