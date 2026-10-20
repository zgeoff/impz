import { findSchemaMap } from './find-schema-map';
import { findValues } from './find-values';
import type { SchemaObject } from './schema';

// A union's discriminator: the properties every option on both sides fixes
// to one value, on which the options of one side differ. A version field
// that every option fixes alike tells no option apart, though it changes.
export function collectTagKeys(sides: readonly (readonly SchemaObject[])[]): readonly string[] {
  const options = sides.flat();
  const [first] = options;

  if (first === undefined) {
    return [];
  }

  return Object.keys(findSchemaMap(first, 'properties')).filter(
    (key) =>
      options.every((option) => findTag(option, key) !== undefined) &&
      sides.some(
        (side) => new Set(side.map((option) => JSON.stringify(findTag(option, key)))).size > 1,
      ),
  );
}

// the one value a schema fixes a property to
function findTag(schema: SchemaObject, key: string): unknown {
  const property = findSchemaMap(schema, 'properties')[key];
  const values = property === undefined ? undefined : findValues(property);

  return values?.length === 1 ? values[0] : undefined;
}
