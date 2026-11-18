import { expect, test } from 'bun:test';
import { SessionSchema } from '../schemas/session-schema';
import { buildMockSession } from './build-mock-session';

test('it builds a default session', () => {
  const session = buildMockSession();
  const parsed: unknown = SessionSchema.safeParse(session).data;
  const received: unknown = session;

  expect(received).toStrictEqual({
    name: expect.stringMatching(/^[a-z0-9][a-z0-9-]{2,12}$/u),
    pid: expect.any(Number),
    argv: [expect.any(String)],
    state: 'running',
    attached: false,
    cols: expect.any(Number),
    rows: expect.any(Number),
    startedAt: expect.toBeValidDate(),
    continuity: 'offsets',
    executionGeneration: expect.stringMatching(/^[0-9a-f]{32}$/u),
    bootId: expect.any(String),
    end: expect.any(Number),
    endObservedAt: expect.toBeValidDate(),
    log: false,
  });

  expect(parsed).toStrictEqual(session);
  expect(session.endObservedAt).not.toBeBefore(session.startedAt);
});

test('it applies overrides on top of the defaults', () => {
  const session: unknown = buildMockSession({
    name: 'job',
    state: 'exited',
    exit: { code: 3, signal: null },
  });

  expect(session).toStrictEqual({
    name: 'job',
    pid: expect.any(Number),
    argv: [expect.any(String)],
    state: 'exited',
    attached: false,
    cols: expect.any(Number),
    rows: expect.any(Number),
    startedAt: expect.toBeValidDate(),
    continuity: 'offsets',
    executionGeneration: expect.stringMatching(/^[0-9a-f]{32}$/u),
    bootId: expect.any(String),
    end: expect.any(Number),
    endObservedAt: expect.toBeValidDate(),
    log: false,
    exit: { code: 3, signal: null },
  });
});
