import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/server';
import { ImpdError } from '../platform/errors/impd-error';
import { readErrorCode } from './read-error-code';

test("it reads a domain error's code", () => {
  expect(readErrorCode(new ImpdError('NOT_FOUND', { message: 'imp dev not found' }))).toBe(
    'NOT_FOUND',
  );
});

test("it reads an oRPC error's code", () => {
  expect(readErrorCode(new ORPCError('BAD_REQUEST'))).toBe('BAD_REQUEST');
});

test('it reads any other failure as an internal error', () => {
  expect(readErrorCode(new Error('boom'))).toBe('INTERNAL_SERVER_ERROR');
});
