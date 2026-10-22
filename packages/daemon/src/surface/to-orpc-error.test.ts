import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/server';
import { ImpdError } from '../platform/errors/impd-error';
import { toORPCError } from './to-orpc-error';

test('it sends a domain error with its code, status, message and data', () => {
  const error = toORPCError(
    new ImpdError('MOVING', {
      status: 409,
      message: 'dev is moving between hosts',
      data: { retryAfterS: 30 },
    }),
  );

  expect(error).toBeInstanceOf(ORPCError);

  expect(error).toMatchObject({
    code: 'MOVING',
    status: 409,
    message: 'dev is moving between hosts',
    data: { retryAfterS: 30 },
  });
});

test("it gives a domain error with no status its code's own status", () => {
  expect(toORPCError(new ImpdError('NOT_FOUND', { message: 'imp dev not found' }))).toMatchObject({
    code: 'NOT_FOUND',
    status: 404,
  });
});

test('it keeps the cause of a domain error', () => {
  const cause = new Error('ENOSPC');

  expect(
    toORPCError(new ImpdError('INTERNAL_SERVER_ERROR', { message: 'write failed', cause })),
  ).toMatchObject({ cause });
});

test('it passes any other error as it is', () => {
  const error = new Error('boom');

  expect(toORPCError(error)).toBe(error);
});
