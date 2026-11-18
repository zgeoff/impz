import { expect, test } from 'bun:test';
import { ImpSchema } from '../schemas/imp-schema';
import { buildMockImp } from './build-mock-imp';

test('it builds a default imp', () => {
  const imp = buildMockImp();
  const parsed: unknown = ImpSchema.safeParse(imp).data;
  const received: unknown = imp;

  expect(received).toStrictEqual({
    id: expect.any(String),
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u),
    image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u),
    state: 'running',
    kind: 'user',
    vcpus: expect.any(Number),
    memoryMib: expect.any(Number),
    maxMemoryMib: expect.any(Number),
    pluggedMib: expect.any(Number),
    diskMib: expect.any(Number),
    diskUsage: {
      exclusiveBytes: expect.any(Number),
      sharedBytes: expect.any(Number),
      measuredAt: expect.toBeValidDate(),
      isPartial: false,
      isUpperBound: false,
    },
    ip: expect.any(String),
    slot: expect.any(Number),
    port: expect.any(Number),
    httpPort: expect.any(Number),
    url: expect.any(String),
    public: { auth: 'token' },
    createdAt: expect.toBeBefore(new Date('2026-01-01T00:00:00.000Z')),
    lastActiveAt: expect.toBeValidDate(),
    lastRequestAt: expect.toBeValidDate(),
    ramMib: expect.any(Number),
    rssMib: expect.any(Number),
    sleptAt: expect.toBeValidDate(),
    holdUntil: expect.toBeValidDate(),
    leases: { leases: [], otherCount: 0 },
    error: expect.any(String),
    sessions: expect.any(Number),
    coldBootReason: expect.any(String),
    agentSilentSince: expect.toBeValidDate(),
    inner: {
      up: true,
      restarts: expect.any(Number),
      lastError: expect.any(String),
    },
    outdated: [],
    cpu: { limit: null, weight: 100 },
    resources: { wakeCount: expect.any(Number), awakeMs: expect.any(Number) },
    move: 'sending',
  });

  expect(parsed).toStrictEqual(imp);
  expect(imp.lastActiveAt).not.toBeBefore(imp.createdAt);
});

test('it applies overrides on top of the defaults', () => {
  const imp: unknown = buildMockImp({
    name: 'dev-b',
    state: 'sleeping',
    vcpus: 2,
    inner: { up: false },
    cpu: { limit: 1.5 },
  });

  expect(imp).toStrictEqual({
    id: expect.any(String),
    name: 'dev-b',
    image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u),
    state: 'sleeping',
    kind: 'user',
    vcpus: 2,
    memoryMib: expect.any(Number),
    maxMemoryMib: expect.any(Number),
    pluggedMib: expect.any(Number),
    diskMib: expect.any(Number),
    diskUsage: {
      exclusiveBytes: expect.any(Number),
      sharedBytes: expect.any(Number),
      measuredAt: expect.toBeValidDate(),
      isPartial: false,
      isUpperBound: false,
    },
    ip: expect.any(String),
    slot: expect.any(Number),
    port: expect.any(Number),
    httpPort: expect.any(Number),
    url: expect.any(String),
    public: { auth: 'token' },
    createdAt: expect.toBeBefore(new Date('2026-01-01T00:00:00.000Z')),
    lastActiveAt: expect.toBeValidDate(),
    lastRequestAt: expect.toBeValidDate(),
    ramMib: expect.any(Number),
    rssMib: expect.any(Number),
    sleptAt: expect.toBeValidDate(),
    holdUntil: expect.toBeValidDate(),
    leases: { leases: [], otherCount: 0 },
    error: expect.any(String),
    sessions: expect.any(Number),
    coldBootReason: expect.any(String),
    agentSilentSince: expect.toBeValidDate(),
    inner: {
      up: false,
      restarts: expect.any(Number),
      lastError: expect.any(String),
    },
    outdated: [],
    cpu: { limit: 1.5, weight: 100 },
    resources: { wakeCount: expect.any(Number), awakeMs: expect.any(Number) },
    move: 'sending',
  });
});
