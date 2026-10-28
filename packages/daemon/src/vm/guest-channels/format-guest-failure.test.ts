import { expect, test } from 'bun:test';
import { ImpdError } from '../../platform/errors/impd-error';
import { AgentError } from '../agent-client/agent-connection';
import { formatGuestFailure } from './format-guest-failure';

test('it formats an agent error as its code and detail', () => {
  expect(formatGuestFailure(new AgentError('DIAL_FAILED', 'connection refused'))).toBe(
    'DIAL_FAILED: connection refused',
  );
});

test('it formats an API error as its code and message', () => {
  expect(formatGuestFailure(new ImpdError('NOT_FOUND', { message: 'no imp named box' }))).toBe(
    'NOT_FOUND: no imp named box',
  );
});

test('it formats any other error as its message', () => {
  expect(formatGuestFailure(new Error('socket hang up'))).toBe('socket hang up');
});
