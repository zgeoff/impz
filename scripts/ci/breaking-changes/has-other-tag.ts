import { findSchemaMap } from './find-schema-map';
import { findValues } from './find-values';
import { isSchemaObject } from './is-schema-object';
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

  const narrowProperties = findSchemaMap(narrow, 'properties');
  const wideProperties = findSchemaMap(wide, 'properties');

  return tagKeys.some((key) => {
    const narrowProperty = narrowProperties[key];
    const wideProperty = wideProperties[key];
    const narrowValues = narrowProperty === undefined ? undefined : findValues(narrowProperty);
    const wideValues = wideProperty === undefined ? undefined : findValues(wideProperty);

    return (
      narrowValues !== undefined &&
      wideValues !== undefined &&
      !narrowValues.some((value) => wideValues.some((other) => Bun.deepEquals(value, other, true)))
    );
  });
}
