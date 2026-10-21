import { collectSchemaMap } from './collect-schema-map';
import { findValues } from './find-values';
import type { SchemaObject } from './schema';

// A field that every option fixes to the same value, such as a version, tells no option apart,
// even when that value changes between sides.
export function collectTagKeys(sides: readonly (readonly SchemaObject[])[]): readonly string[] {
  const options = sides.flat();
  const [first] = options;

  if (first === undefined) {
    return [];
  }

  return Object.keys(collectSchemaMap(first, 'properties')).filter(
    (key) =>
      options.every((option) => findTag(option, key) !== undefined) &&
      sides.some(
        (side) => new Set(side.map((option) => JSON.stringify(findTag(option, key)))).size > 1,
      ),
  );
}

function findTag(schema: SchemaObject, key: string): unknown {
  const property = collectSchemaMap(schema, 'properties')[key];
  const values = property === undefined ? undefined : findValues(property);

  return values?.length === 1 ? values[0] : undefined;
}
