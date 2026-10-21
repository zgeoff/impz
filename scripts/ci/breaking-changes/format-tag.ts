import { collectSchemaMap } from './collect-schema-map';
import { findValues } from './find-values';
import { formatValues } from './format-values';
import type { SchemaObject } from './schema';

export function formatTag(schema: SchemaObject, tagKeys: readonly string[]): string {
  const properties = collectSchemaMap(schema, 'properties');

  for (const key of tagKeys) {
    const property = properties[key];
    const values = property === undefined ? undefined : findValues(property);

    if (values !== undefined) {
      return `${key} ${formatValues(values)}`;
    }
  }

  return 'without a tag';
}
