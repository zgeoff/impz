import { expect, test } from 'bun:test';
import { ImpdError } from '../../platform/errors/impd-error';
import { AgentError } from '../agent-client/agent-connection';
import { buildGuestFailure } from './build-guest-failure';

test('it keeps an API error code, message and data', () => {
  const error = new ImpdError('TUNNEL_LIMIT', { message: 'box has 4 tunnels open already' });

  expect(buildGuestFailure(error)).toStrictEqual({
    code: 'TUNNEL_LIMIT',
    message: 'box has 4 tunnels open already',
  });
});

test('it keeps an agent error code, detail and data', () => {
  const error = new AgentError('MISSING_COMMAND', 'no such file', { argv0: 'lsx' });

  expect(buildGuestFailure(error)).toStrictEqual({
    code: 'MISSING_COMMAND',
    message: 'no such file',
    data: { argv0: 'lsx' },
  });
});

test('it gives any other error only its message', () => {
  expect(buildGuestFailure(new Error('socket hang up'))).toStrictEqual({
    message: 'socket hang up',
  });
});
