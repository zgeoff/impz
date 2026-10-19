import type { Bound } from './bound';
import { pickTighter } from './pick-tighter';
import { readInclusive } from './read-inclusive';
import type { SchemaObject } from './schema';

export function readLower(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMinimum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(readInclusive(schema, 'minimum'), exclusiveBound, 'lower');
}
