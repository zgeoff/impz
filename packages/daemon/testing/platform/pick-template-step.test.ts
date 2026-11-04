import { expect, test } from 'bun:test';
import type { TemplateFile } from './is-stale-template-file';
import { pickTemplateStep } from './pick-template-step';
import type { TemplateStep } from './pick-template-step';

test.each<[TemplateStep, string, boolean, TemplateFile | null]>([
  ['reuse', 'the template exists', true, null],
  [
    'reuse',
    'the template exists beside a lock',
    true,
    { name: '003_add_broker-0123456789abcdef.sqlite.lock', ageMs: 1000, isOwnerGone: false },
  ],
  ['build', 'neither the template nor a lock exists', false, null],
  [
    'remove-lock',
    'the lock is stale',
    false,
    { name: '003_add_broker-0123456789abcdef.sqlite.lock', ageMs: 1000, isOwnerGone: true },
  ],
  [
    'wait',
    'a running build holds the lock',
    false,
    { name: '003_add_broker-0123456789abcdef.sqlite.lock', ageMs: 1000, isOwnerGone: false },
  ],
])('it picks %s when %s', (step, _, hasTemplate, lock) => {
  expect(pickTemplateStep(hasTemplate, lock, '0123456789abcdef')).toBe(step);
});
