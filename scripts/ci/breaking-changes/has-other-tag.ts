import { isSchemaObject } from './is-schema-object';
import { readSchemaMap } from './read-schema-map';
import { readValues } from './read-values';
import type { Schema, SchemaObject } from './schema';

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
