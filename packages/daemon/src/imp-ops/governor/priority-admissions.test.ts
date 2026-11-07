import { expect, test } from 'bun:test';
import { createPriorityAdmissions } from './priority-admissions';

test.each([
  { request: { id: 'a', name: 'chat-a', reserveMib: 100, memoryMib: 200 }, isPriority: true },
  {
    request: {
      id: 'a',
      name: 'imp-build-a',
      priorityName: 'chat-notes',
      reserveMib: 100,
      memoryMib: 200,
    },
    isPriority: true,
  },
  {
    request: { id: 'a', name: 'chat-a', priorityName: 'box', reserveMib: 100, memoryMib: 200 },
    isPriority: false,
  },
  { request: { id: 'a', name: 'imp-build-a', reserveMib: 100, memoryMib: 200 }, isPriority: false },
])(
  '#isPriorityRequest matches priority name $request.priorityName, else name $request.name: $isPriority',
  (row) => {
    const admissions = createPriorityAdmissions({ mib: 400, patterns: ['chat-*'] });

    expect(admissions.isPriorityRequest(row.request)).toBe(row.isPriority);
  },
);

test('it counts an imp admitted under a priority name as a priority imp', () => {
  const admissions = createPriorityAdmissions({ mib: 400, patterns: ['chat-*'] });

  admissions.recordAdmission({
    id: 'a',
    name: 'imp-build-a',
    priorityName: 'chat-notes',
    reserveMib: 100,
    memoryMib: 200,
  });

  expect(admissions.isPriorityImp({ id: 'a', name: 'imp-build-a' })).toBeTrue();
});

test('it no longer counts an imp admitted under a priority name once it is released', () => {
  const admissions = createPriorityAdmissions({ mib: 400, patterns: ['chat-*'] });

  admissions.recordAdmission({
    id: 'a',
    name: 'imp-build-a',
    priorityName: 'chat-notes',
    reserveMib: 100,
    memoryMib: 200,
  });

  admissions.release('a');

  expect(admissions.isPriorityImp({ id: 'a', name: 'imp-build-a' })).toBeFalse();
});

test('it no longer counts an imp as priority after an admission outside the patterns', () => {
  const admissions = createPriorityAdmissions({ mib: 400, patterns: ['chat-*'] });

  admissions.recordAdmission({
    id: 'a',
    name: 'imp-build-a',
    priorityName: 'chat-notes',
    reserveMib: 100,
    memoryMib: 200,
  });

  admissions.recordAdmission({ id: 'a', name: 'imp-build-a', reserveMib: 100, memoryMib: 200 });

  expect(admissions.isPriorityImp({ id: 'a', name: 'imp-build-a' })).toBeFalse();
});

test('it counts no imp as priority when the host keeps no RAM for priority imps', () => {
  const admissions = createPriorityAdmissions(null);

  expect(admissions.isPriority('chat-a')).toBeFalse();
});
