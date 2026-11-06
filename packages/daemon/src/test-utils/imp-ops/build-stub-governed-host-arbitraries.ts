import fc from 'fast-check';
import type { HostChange } from './create-stub-governed-host';

export function buildStubGovernedHostArbitraries(ids: readonly string[]) {
  const id = fc.constantFrom(...ids);

  return {
    awake: fc.uniqueArray(
      fc.record({
        id,
        rssMib: fc.integer({ min: 0, max: 400 }),
        failsSleep: fc.nat({ max: 3 }).map((roll) => roll === 0),
      }),
      { selector: (imp) => imp.id, maxLength: ids.length },
    ),
    admit: fc.record({
      kind: fc.constant('admit' as const),
      id,
      reserveMib: fc.integer({ min: 50, max: 700 }),
      extraMib: fc.integer({ min: 0, max: 600 }),
    }),
    change: fc.oneof<fc.Arbitrary<HostChange>[]>(
      fc.record({ kind: fc.constant('rss' as const), id, mib: fc.integer({ min: 0, max: 600 }) }),
      fc.record({ kind: fc.constant('hold' as const), id, on: fc.boolean() }),
      fc.record({ kind: fc.constant('busy' as const), id, on: fc.boolean() }),
      fc.record({ kind: fc.constant('failSleep' as const), id, on: fc.boolean() }),
      fc.record({ kind: fc.constant('spare' as const), id, mib: fc.integer({ min: 0, max: 300 }) }),
      fc.record({ kind: fc.constant('touch' as const), id }),
      fc.record({ kind: fc.constant('stop' as const), id }),
      fc.record({
        kind: fc.constant('tick' as const),
        durationMs: fc.integer({ min: 0, max: 25_000 }),
      }),
    ),
  };
}
