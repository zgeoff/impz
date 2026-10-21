import type { Bound, Side } from './bound';

export function isWithin(inner: Bound, outer: Bound, side: Side): boolean {
  const ahead = side === 'lower' ? inner.value > outer.value : inner.value < outer.value;

  return ahead || (inner.value === outer.value && (inner.exclusive || !outer.exclusive));
}
