import { collectBoundChange } from './collect-bound-change';
import type { Comparison } from './comparison';
import { findInclusive } from './find-inclusive';
import { findLower } from './find-lower';
import { findUpper } from './find-upper';
import { formatChange } from './format-change';
import { formatSides } from './format-sides';
import { formatValue } from './format-value';
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
    ['lower bound', findLower(narrow), findLower(wide), 'lower'],
    ['upper bound', findUpper(narrow), findUpper(wide), 'upper'],
    ['min items', findInclusive(narrow, 'minItems'), findInclusive(wide, 'minItems'), 'lower'],
    ['max items', findInclusive(narrow, 'maxItems'), findInclusive(wide, 'maxItems'), 'upper'],
  ] as const;

  return [
    ...pairs.flatMap(([name, narrowBound, wideBound, side]) =>
      collectBoundChange({ name, narrow: narrowBound, wide: wideBound, side, path, comparison }),
    ),
    ...(fitsStep ? [] : [formatChange(path, `multipleOf ${stepChange}`)]),
  ];
}
