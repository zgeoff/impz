import { formatValues } from './format-values';
import { readSchemaMap } from './read-schema-map';
import { readValues } from './read-values';
import type { SchemaObject } from './schema';

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
