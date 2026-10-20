import { expect, test } from 'bun:test';
import { GuardError, buildImpGuard, createPatternGuard } from './imp-guard';

test('#buildImpGuard refuses a guard with no prefix, allow-list or --all', () => {
  expect(() => buildImpGuard({})).toThrowWithMessage(
    GuardError,
    'choose the imps this server may touch: --prefix, --allow or --all',
  );
});

test('#buildImpGuard refuses --all together with a prefix', () => {
  expect(() => buildImpGuard({ all: true, prefix: 'a-' })).toThrowWithMessage(
    GuardError,
    '--all allows every imp; leave out --prefix and --allow',
  );
});

test('#buildImpGuard refuses --all together with an allow-list', () => {
  expect(() => buildImpGuard({ all: true, allow: ['a'] })).toThrowWithMessage(
    GuardError,
    '--all allows every imp; leave out --prefix and --allow',
  );
});

test.each([['Agent-'], ['-x'], ['aaaaaaaaaaaaaaaaaaaaaaaa']])(
  '#buildImpGuard refuses the prefix %s',
  (prefix) => {
    expect(() => buildImpGuard({ prefix })).toThrowWithMessage(
      GuardError,
      `--prefix ${prefix}: must start with a lowercase letter, hold only lowercase letters, digits and hyphens, and be at most 23 characters`,
    );
  },
);

test('#buildImpGuard picks a 31-character name under the longest prefix it takes', () => {
  const guard = buildImpGuard({ prefix: 'aaaaaaaaaaaaaaaaaaaaaaa' });
  const name = guard.pickNewName();

  expect(name).toMatch(/^a{23}[a-z0-9]{8}$/u);
});

test('#buildImpGuard refuses an allow-list that holds an invalid name', () => {
  expect(() => buildImpGuard({ allow: ['ok', 'Not Ok'] })).toThrowWithMessage(
    GuardError,
    '--allow: Not Ok is not a valid imp name',
  );
});

test.each([
  ['agent-x', true],
  ['shared', true],
  ['shared2', false],
  ['agent', false],
])('#buildImpGuard answers %s with %p under a prefix and an allow-list', (name, allowed) => {
  const guard = buildImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(guard.isAllowed(name)).toBe(allowed);
});

test('#buildImpGuard names both the prefix and the allow-list in its summary', () => {
  const guard = buildImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(guard.summary).toBe('imps named agent-* and the imps shared');
});

test('#buildImpGuard passes an imp inside the guard', () => {
  const guard = buildImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(() => {
    guard.require('agent-x');
  }).not.toThrow();
});

test('#buildImpGuard refuses an imp outside the guard with the summary', () => {
  const guard = buildImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(() => {
    guard.require('prod');
  }).toThrowWithMessage(
    GuardError,
    "imp prod is outside this server's guard: imps named agent-* and the imps shared",
  );
});

test('#buildImpGuard allows every imp under --all', () => {
  const guard = buildImpGuard({ all: true });

  expect(guard.isAllowed('anything')).toBeTrue();
});

test('#buildImpGuard leaves the new name to impd under --all', () => {
  const guard = buildImpGuard({ all: true });

  expect(guard.pickNewName()).toBeNull();
});

test('#buildImpGuard summarises --all as every imp', () => {
  const guard = buildImpGuard({ all: true });

  expect(guard.summary).toBe('every imp');
});

test('#buildImpGuard asks for a name when only an allow-list guards the server', () => {
  const guard = buildImpGuard({ allow: ['shared', 'box'] });

  expect(() => guard.pickNewName()).toThrowWithMessage(
    GuardError,
    'give a name: the imps shared, box',
  );
});

test('#createPatternGuard picks a name under a single prefix pattern', () => {
  const guard = createPatternGuard(['agent-*']);

  expect(guard.pickNewName()).toMatch(/^agent-[a-z0-9]{8}$/u);
});

test('#createPatternGuard leaves every imp to impd to refuse', () => {
  const guard = createPatternGuard(['agent-*']);

  expect(guard.isAllowed('anything')).toBeTrue();
});

test('#createPatternGuard summarises the patterns', () => {
  const guard = createPatternGuard(['agent-*', 'box']);

  expect(guard.summary).toBe('imps matching agent-*, box');
});

test.each([
  [['a-*', 'b-*'], 'a-*, b-*'],
  [['box'], 'box'],
  [['a*b*'], 'a*b*'],
  [['aaaaaaaaaaaaaaaaaaaaaaaa*'], 'aaaaaaaaaaaaaaaaaaaaaaaa*'],
])('#createPatternGuard asks for a name under the patterns %p', (patterns, listed) => {
  const guard = createPatternGuard(patterns);

  expect(() => guard.pickNewName()).toThrowWithMessage(
    GuardError,
    `this token may touch only imps matching ${listed}, so give the new imp a name that matches`,
  );
});

test('#createPatternGuard leaves the new name to impd for a token with no patterns', () => {
  const guard = createPatternGuard(null);

  expect(guard.pickNewName()).toBeNull();
});
