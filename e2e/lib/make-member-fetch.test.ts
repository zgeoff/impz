import { expect, mock, test } from 'bun:test';
import type { CommandRunners } from './instance';
import { makeMemberFetch } from './make-member-fetch';

function setupTest() {
  const runCommand = mock<CommandRunners['runCommand']>();

  return { runCommand };
}

test('it sends the request raw to the tailnet address through the member’s nc', async () => {
  const ctx = setupTest();

  ctx.runCommand.mockResolvedValue({
    exitCode: 0,
    stdout: 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"json":{}}',
    stderr: '',
  });

  const send = makeMemberFetch('imp-e2e-a-ts-member', { runCommand: ctx.runCommand });

  await send(
    new Request('http://100.64.0.7:7070/rpc/tokens/whoami', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"json":{"name":"café"}}',
    }),
  );

  expect(ctx.runCommand).toHaveBeenCalledExactlyOnceWith(
    [
      'docker',
      'exec',
      '-i',
      'imp-e2e-a-ts-member',
      'sh',
      '-c',
      expect.toInclude('nc -w 30 "$0" "$1"'),
      '100.64.0.7',
      '7070',
    ],
    {
      stdin:
        'POST /rpc/tokens/whoami HTTP/1.0\r\nhost: 100.64.0.7:7070\r\ncontent-type: application/json\r\ncontent-length: 25\r\n\r\n{"json":{"name":"café"}}',
    },
  );
});

test('it gives the status, headers and body of an error response', async () => {
  const ctx = setupTest();

  ctx.runCommand.mockResolvedValue({
    exitCode: 0,
    stdout:
      'HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: 34\r\n\r\n{"json":{"code":"FORBIDDEN"}}\r\n\r\n',
    stderr: '',
  });

  const send = makeMemberFetch('imp-e2e-a-ts-member', { runCommand: ctx.runCommand });

  const response = await send(
    new Request('http://100.64.0.7:7070/rpc/imps/stop', { method: 'POST', body: '{}' }),
  );

  const body = await response.text();

  expect(response.status).toBe(403);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(body).toBe('{"json":{"code":"FORBIDDEN"}}\r\n\r\n');
});

test('it fails when the member’s nc reaches no server', () => {
  const ctx = setupTest();

  ctx.runCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'nc: timed out\n' });

  const send = makeMemberFetch('imp-e2e-a-ts-member', { runCommand: ctx.runCommand });

  expect(
    send(new Request('http://100.64.0.7:7070/rpc/imps/stop', { method: 'POST', body: '{}' })),
  ).rejects.toThrowWithMessage(
    Error,
    'POST http://100.64.0.7:7070/rpc/imps/stop from imp-e2e-a-ts-member exited 1: nc: timed out',
  );
});

test('it fails on output that holds no HTTP response', () => {
  const ctx = setupTest();

  ctx.runCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  const send = makeMemberFetch('imp-e2e-a-ts-member', { runCommand: ctx.runCommand });

  expect(
    send(new Request('http://100.64.0.7:7070/rpc/imps/stop', { method: 'POST', body: '{}' })),
  ).rejects.toThrowWithMessage(Error, 'no HTTP response: ');
});
