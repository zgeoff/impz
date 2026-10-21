import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { OKSchema, RequestSchema } from './agent-protocol';
import { decodeMessageFrame } from './decode-message-frame';
import { FRAME_TYPES } from './frame-codec';

test('it decodes a frame’s JSON payload into the schema’s message', () => {
  const frame = {
    type: FRAME_TYPES.request,
    payload: new TextEncoder().encode('{"op":"exec","argv":["make"],"kill_grace_ms":5000}'),
  };

  expect(decodeMessageFrame(RequestSchema, frame)).toStrictEqual(
    create(RequestSchema, { op: 'exec', argv: ['make'], killGraceMs: 5000 }),
  );
});

test('it throws for a payload that is not JSON', () => {
  expect(() =>
    decodeMessageFrame(RequestSchema, {
      type: FRAME_TYPES.request,
      payload: new TextEncoder().encode('{"op":'),
    }),
  ).toThrow(SyntaxError);
});

test('it throws for an answer the agent did not acknowledge', () => {
  expect(() =>
    decodeMessageFrame(OKSchema, {
      type: FRAME_TYPES.response,
      payload: new TextEncoder().encode('{"ok":false}'),
    }),
  ).toThrowWithMessage(Error, 'imp.agent.v1.OK: the agent did not acknowledge the op');
});
