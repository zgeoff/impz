import { expect, mock, test } from 'bun:test';
import { buildDeferredAdmission } from './build-deferred-admission';

test('it refuses a boot admission before a governor is attached', () => {
  const deferred = buildDeferredAdmission();

  expect(() =>
    deferred.admission.admit({ id: 'imp-1', name: 'dev', reserveMib: 256, memoryMib: 1024 }),
  ).toThrowWithMessage(Error, /RAM governor/u);
});

test('it refuses a memory grow before a governor is attached', () => {
  const deferred = buildDeferredAdmission();

  expect(() => deferred.admitGrow({ id: 'imp-1', name: 'dev', mib: 512 })).toThrowWithMessage(
    Error,
    /RAM governor/u,
  );
});

test('it hands a boot admission to the attached governor', async () => {
  const deferred = buildDeferredAdmission();
  const admit = mock(() => Promise.resolve());

  deferred.attach({
    admit,
    release: () => {},
    admitGrow: () => Promise.resolve(true),
    releaseGrow: () => {},
  });

  await deferred.admission.admit({ id: 'imp-1', name: 'dev', reserveMib: 256, memoryMib: 1024 });

  expect(admit).toHaveBeenCalledExactlyOnceWith({
    id: 'imp-1',
    name: 'dev',
    reserveMib: 256,
    memoryMib: 1024,
  });
});

test('it hands a memory grow to the attached governor and returns its answer', async () => {
  const deferred = buildDeferredAdmission();

  deferred.attach({
    admit: () => Promise.resolve(),
    release: () => {},
    admitGrow: () => Promise.resolve(false),
    releaseGrow: () => {},
  });

  const admitted = await deferred.admitGrow({ id: 'imp-1', name: 'dev', mib: 512 });

  expect(admitted).toBe(false);
});
