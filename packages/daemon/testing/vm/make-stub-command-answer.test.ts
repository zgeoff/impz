import { expect, test } from 'bun:test';
import { makeStubCommandAnswer } from './make-stub-command-answer';

test('it gives a command the answer its first word names', () => {
  const answer = makeStubCommandAnswer(
    { tail: { stdout: 'level=fatal' }, sh: { code: 1, stderr: 'sh: denied' } },
    { code: 1, stderr: 'Cannot connect to the Docker daemon' },
  );

  const tail = answer({
    argv: ['tail', '-n', '5', '/var/log/imp/docker.log'],
    readStdin: () => Promise.resolve(new Uint8Array()),
  });

  expect(tail).toStrictEqual({ stdout: 'level=fatal' });
});

test('it gives a command with no answer of its own the fallback answer', () => {
  const answer = makeStubCommandAnswer(
    { tail: { stdout: 'level=fatal' } },
    { code: 1, stderr: 'Cannot connect to the Docker daemon' },
  );

  const info = answer({
    argv: ['docker', 'info'],
    readStdin: () => Promise.resolve(new Uint8Array()),
  });

  expect(info).toStrictEqual({ code: 1, stderr: 'Cannot connect to the Docker daemon' });
});

test('it gives a command named like an object method the fallback answer', () => {
  const answer = makeStubCommandAnswer({ tail: { stdout: 'level=fatal' } }, { code: 127 });

  const toString = answer({
    argv: ['toString'],
    readStdin: () => Promise.resolve(new Uint8Array()),
  });

  expect(toString).toStrictEqual({ code: 127 });
});
