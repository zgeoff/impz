import type { Bound } from './bound';
import { findInclusive } from './find-inclusive';
import { pickTighter } from './pick-tighter';
import type { SchemaObject } from './schema';

export function findLower(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMinimum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(findInclusive(schema, 'minimum'), exclusiveBound, 'lower');
}
