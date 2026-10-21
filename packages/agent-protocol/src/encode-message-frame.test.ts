import { expect, test } from 'bun:test';
import { ErrorResponseSchema, ExitSchema, StartedSchema } from './agent-protocol';
import { encodeMessageFrame } from './encode-message-frame';
import { FRAME_TYPES } from './frame-codec';

test('it frames a message as its JSON under the schema’s field names', () => {
  const bytes = encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
    pid: 42,
    session: 'build',
    killGraceMs: 5000,
  });

  const json = '{"pid":42,"session":"build","kill_grace_ms":5000}';

  expect([...bytes]).toStrictEqual([7, 0, 0, 0, json.length, ...new TextEncoder().encode(json)]);
});

test('it writes a field at its zero, as the agent does, unless the schema marks it optional', () => {
  const bytes = encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
    error: { code: 'INVALID_RESUME', message: '', data: { end: 100 } },
  });

  expect(new TextDecoder().decode(bytes.subarray(5))).toBe(
    '{"error":{"code":"INVALID_RESUME","message":"","data":{"end":100}}}',
  );
});

test('it writes an exit with no code and no signal as zeros', () => {
  const bytes = encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, {});

  expect(new TextDecoder().decode(bytes.subarray(5))).toBe('{"code":0,"signal":0}');
});
