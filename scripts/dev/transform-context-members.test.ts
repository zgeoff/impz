import { expect, test } from 'bun:test';
import { transformContextMembers } from './transform-context-members';

test('#transformContextMembers qualifies each declaration’s names in its own function', () => {
  const source = [
    'function first(ctx: Ctx) {',
    '  const { a } = ctx;',
    '  return a + 1;',
    '}',
    '',
    'function second(ctx: Ctx) {',
    '  const { b } = ctx;',
    '  return [a, b];',
    '}',
    '',
  ].join('\n');

  const rewritten = transformContextMembers(source);

  expect(rewritten).toBe(
    [
      'function first(ctx: Ctx) {',
      '  return ctx.a + 1;',
      '}',
      '',
      'function second(ctx: Ctx) {',
      '  return [a, ctx.b];',
      '}',
      '',
    ].join('\n'),
  );
});

test('#transformContextMembers qualifies a spread name, and leaves members, keys, strings and comments', () => {
  const source = [
    'function read(ctx: Ctx) {',
    '  const { taps, live } = ctx;',
    "  // taps and live, 'taps'",
    "  const label = 'live';",
    '  return { live, taps: [...taps.keys()], other: other.live, label };',
    '}',
    '',
  ].join('\n');

  const rewritten = transformContextMembers(source);

  expect(rewritten).toBe(
    [
      'function read(ctx: Ctx) {',
      "  // taps and live, 'taps'",
      "  const label = 'live';",
      '  return { live: ctx.live, taps: [...ctx.taps.keys()], other: other.live, label };',
      '}',
      '',
    ].join('\n'),
  );
});
