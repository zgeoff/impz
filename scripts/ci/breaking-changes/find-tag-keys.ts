import { readSchemaMap } from './read-schema-map';
import { readValues } from './read-values';
import type { SchemaObject } from './schema';

// A union's discriminator: the properties every option on both sides fixes
// to one value, on which the options of one side differ. A version field
// that every option fixes alike tells no option apart, though it changes.
export function findTagKeys(sides: readonly (readonly SchemaObject[])[]): readonly string[] {
  const options = sides.flat();
  const [first] = options;

  if (first === undefined) {
    return [];
  }

  return Object.keys(readSchemaMap(first, 'properties')).filter(
    (key) =>
      options.every((option) => readTag(option, key) !== undefined) &&
      sides.some(
        (side) => new Set(side.map((option) => JSON.stringify(readTag(option, key)))).size > 1,
      ),
  );
}

// the one value a schema fixes a property to
function readTag(schema: SchemaObject, key: string): unknown {
  const property = readSchemaMap(schema, 'properties')[key];
  const values = property === undefined ? undefined : readValues(property);

  return values?.length === 1 ? values[0] : undefined;
}
