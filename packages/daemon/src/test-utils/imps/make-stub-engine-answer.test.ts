import { expect, test } from 'bun:test';
import { makeStubEngineAnswer } from './make-stub-engine-answer';

test('it refuses docker info as often as asked, then answers it', () => {
  const answer = makeStubEngineAnswer({ refusals: 2, answer: { stdout: 'ok' } });
  const info = { argv: ['docker', 'info'], readStdin: () => Promise.resolve(new Uint8Array()) };
  const answers = [answer(info), answer(info), answer(info)];

  expect(answers).toStrictEqual([
    { code: 1, stderr: 'Cannot connect to the Docker daemon' },
    { code: 1, stderr: 'Cannot connect to the Docker daemon' },
    {},
  ]);
});

test('it gives every other command its answer, and counts no refusal for it', () => {
  const answer = makeStubEngineAnswer({ refusals: 1, answer: { stdout: 'ok' } });
  const echo = { argv: ['echo'], readStdin: () => Promise.resolve(new Uint8Array()) };
  const info = { argv: ['docker', 'info'], readStdin: () => Promise.resolve(new Uint8Array()) };
  const answers = [answer(echo), answer(info), answer(info)];

  expect(answers).toStrictEqual([
    { stdout: 'ok' },
    { code: 1, stderr: 'Cannot connect to the Docker daemon' },
    {},
  ]);
});
