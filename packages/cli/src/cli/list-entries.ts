export function listEntries<T>(
  table: Readonly<Record<string, T>> | ReadonlyMap<string, T>,
): [string, T][] {
  return isMap(table) ? [...table] : Object.entries(table);
}

function isMap<T>(
  table: Readonly<Record<string, T>> | ReadonlyMap<string, T>,
): table is ReadonlyMap<string, T> {
  return table instanceof Map;
}
