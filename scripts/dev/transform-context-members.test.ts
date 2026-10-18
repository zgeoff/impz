import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformContextMembers } from './transform-context-members';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'context-members-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root, script: join(import.meta.dir, 'transform-context-members.ts') };
}

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

test('#transformContextMembers leaves a regex literal, and qualifies a name after one or a division', () => {
  const source = [
    'function match(ctx: Ctx) {',
    '  const { a } = ctx;',
    '  const half = a / 2;',
    String.raw`  return /a[/a]\/a/gv.test(a) && [/a/].length / a;`,
    '}',
    '',
  ].join('\n');

  const rewritten = transformContextMembers(source);

  expect(rewritten).toBe(
    [
      'function match(ctx: Ctx) {',
      '  const half = ctx.a / 2;',
      String.raw`  return /a[/a]\/a/gv.test(ctx.a) && [/a/].length / ctx.a;`,
      '}',
      '',
    ].join('\n'),
  );
});

test('the command writes the qualified source to each file it is given', async () => {
  const ctx = await setupTest();

  const file = join(ctx.root, 'kettle.ts');

  await Bun.write(
    file,
    'function boil(ctx: Ctx) {\n  const { water } = ctx;\n  return water;\n}\n',
  );

  const result = Bun.spawnSync(['bun', ctx.script, file]);

  expect(result.exitCode).toBe(0);

  const written = await Bun.file(file).text();

  expect(written).toBe('function boil(ctx: Ctx) {\n  return ctx.water;\n}\n');
});
