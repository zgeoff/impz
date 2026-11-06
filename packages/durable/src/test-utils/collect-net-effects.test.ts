import { expect, test } from 'bun:test';
import { collectNetEffects } from './collect-net-effects';

test('it keeps each effect no undo follows, in the order made', () => {
  const kept = collectNetEffects(['measure', 'cut', 'undo cut', 'assemble']);

  expect(kept).toStrictEqual(['measure', 'assemble']);
});

test('it counts an effect made twice once', () => {
  const kept = collectNetEffects(['cut', 'cut']);

  expect(kept).toStrictEqual(['cut']);
});

test('it returns nothing when every effect was undone', () => {
  const kept = collectNetEffects(['measure', 'cut', 'undo cut', 'undo measure']);

  expect(kept).toStrictEqual([]);
});
