import { collectBoundChange } from './collect-bound-change';
import type { Comparison } from './comparison';
import { formatChange } from './format-change';
import { formatSides } from './format-sides';
import { formatValue } from './format-value';
import { readInclusive } from './read-inclusive';
import { readLower } from './read-lower';
import { readUpper } from './read-upper';
import type { SchemaObject } from './schema';

export function collectBoundChanges(
  narrow: SchemaObject,
  wide: SchemaObject,
  path: string,
  comparison: Comparison,
): string[] {
  const step = wide['multipleOf'];
  const narrowStep = narrow['multipleOf'];

  const fitsStep =
    typeof step !== 'number' || (typeof narrowStep === 'number' && narrowStep % step === 0);

  const stepChange = formatSides(comparison, narrowStep, step, formatValue);

  const pairs = [
    ['lower bound', readLower(narrow), readLower(wide), 'lower'],
    ['upper bound', readUpper(narrow), readUpper(wide), 'upper'],
    ['min items', readInclusive(narrow, 'minItems'), readInclusive(wide, 'minItems'), 'lower'],
    ['max items', readInclusive(narrow, 'maxItems'), readInclusive(wide, 'maxItems'), 'upper'],
  ] as const;

  return [
    ...pairs.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange(name, narrowBound, wideBound, side, path, comparison),
    ),
    ...(fitsStep ? [] : [formatChange(path, `multipleOf ${stepChange}`)]),
  ];
}
