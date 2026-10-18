import { formatValues } from './format-value';
import type { Schema, SchemaObject } from './read-schema';
import { isSchemaObject, readSchemaMap, readValues } from './read-schema';

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

// whether the two take no value in common on a discriminator: then they are
// different variants
export function hasOtherTag(
  narrow: SchemaObject,
  wide: Schema,
  tagKeys: readonly string[],
): boolean {
  if (!isSchemaObject(wide)) {
    return false;
  }

  const narrowProperties = readSchemaMap(narrow, 'properties');
  const wideProperties = readSchemaMap(wide, 'properties');

  return tagKeys.some((key) => {
    const narrowProperty = narrowProperties[key];
    const wideProperty = wideProperties[key];
    const narrowValues = narrowProperty === undefined ? undefined : readValues(narrowProperty);
    const wideValues = wideProperty === undefined ? undefined : readValues(wideProperty);

    return (
      narrowValues !== undefined &&
      wideValues !== undefined &&
      !narrowValues.some((value) => wideValues.some((other) => Bun.deepEquals(value, other, true)))
    );
  });
}

// the discriminator's value, as `type "stdout_ack"`
export function formatTag(schema: SchemaObject, tagKeys: readonly string[]): string {
  const properties = readSchemaMap(schema, 'properties');

  for (const key of tagKeys) {
    const property = properties[key];
    const values = property === undefined ? undefined : readValues(property);

    if (values !== undefined) {
      return `${key} ${formatValues(values)}`;
    }
  }

  return 'without a tag';
}
