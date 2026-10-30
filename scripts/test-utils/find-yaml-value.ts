export function findYamlValue(value: unknown, path: readonly (string | number)[]): unknown {
  const [key, ...rest] = path;

  if (key === undefined) {
    return value;
  }

  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }

  return findYamlValue(Reflect.get(value, key), rest);
}
