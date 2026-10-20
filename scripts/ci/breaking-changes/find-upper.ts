import type { Bound } from './bound';
import { findInclusive } from './find-inclusive';
import { pickTighter } from './pick-tighter';
import type { SchemaObject } from './schema';

export function findUpper(schema: SchemaObject): Bound | undefined {
  const exclusive = schema['exclusiveMaximum'];

  const exclusiveBound =
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true } : undefined;

  return pickTighter(findInclusive(schema, 'maximum'), exclusiveBound, 'upper');
}
