import { expect, test } from 'bun:test';
import { DockerfileError } from './dockerfile-error';
import { dockerfileParse, splitDockerfileLines, splitNameWords } from './dockerfile-parse';

test('#splitDockerfileLines splits the lines with their endings, after the byte order mark', () => {
  expect(splitDockerfileLines('﻿FROM a\r\nRUN b\nlast')).toStrictEqual([
    'FROM a\r\n',
    'RUN b\n',
    'last',
  ]);
});

test('#splitDockerfileLines splits an empty Dockerfile into no lines', () => {
  expect(splitDockerfileLines('')).toStrictEqual([]);
});

test('#splitNameWords splits ARG words at spaces outside quotes, keeping quotes and escapes as written', () => {
  expect(splitNameWords(`A=1 "B C"=2 D\\ E='x y'`, '\\')).toStrictEqual([
    'A=1',
    '"B C"=2',
    String.raw`D\ E='x y'`,
  ]);
});

test('#splitNameWords splits ARG words with the backtick escape a directive sets', () => {
  expect(splitNameWords('A`  B C', '`')).toStrictEqual(['A` ', 'B', 'C']);
});

test('#dockerfileParse parses each instruction with its keyword, flags, words and lines', () => {
  expect(
    dockerfileParse('FROM --platform=$BUILDPLATFORM a:1 AS b\nCOPY ["x", "y"]\nONBUILD RUN true\n'),
  ).toStrictEqual({
    escape: '\\',
    instructions: [
      {
        keyword: 'from',
        command: 'FROM',
        flags: ['--platform=$BUILDPLATFORM'],
        rawFlags: '--platform=$BUILDPLATFORM ',
        args: 'a:1 AS b',
        words: ['a:1', 'AS', 'b'],
        isJson: false,
        trigger: null,
        line: 1,
        endLine: 1,
      },
      {
        keyword: 'copy',
        command: 'COPY',
        flags: [],
        rawFlags: '',
        args: '["x", "y"]',
        words: ['x', 'y'],
        isJson: true,
        trigger: null,
        line: 2,
        endLine: 2,
      },
      {
        keyword: 'onbuild',
        command: 'ONBUILD',
        flags: [],
        rawFlags: '',
        args: 'RUN true',
        words: [],
        isJson: false,
        trigger: {
          keyword: 'run',
          command: 'RUN',
          flags: [],
          rawFlags: '',
          args: 'true',
          words: ['true'],
          isJson: false,
          trigger: null,
          line: 3,
          endLine: 3,
        },
        line: 3,
        endLine: 3,
      },
    ],
  });
});

test('#dockerfileParse parses the same instructions from the same Dockerfile', () => {
  const dockerfile = 'FROM a:1 AS b\nRUN --mount=from=c:2 true \\\n  && false\n';

  expect(dockerfileParse(dockerfile)).toStrictEqual(dockerfileParse(dockerfile));
});

test('#dockerfileParse keeps the escape a parser directive sets', () => {
  expect(dockerfileParse('# escape=`\nFROM a:1\n').escape).toBe('`');
});

test('#dockerfileParse ends a continued instruction on the line it ends on', () => {
  const parsed = dockerfileParse('FROM a:1\nRUN echo \\\n  one \\\n  two\n');

  expect(parsed.instructions[1]?.endLine).toBe(4);
});

test('#dockerfileParse refuses an escape parser directive that is neither a backslash nor a backtick', () => {
  expect(() => dockerfileParse('# escape=x\nFROM a:1')).toThrowWithMessage(
    DockerfileError,
    'the escape parser directive "x" is not \\ or `',
  );
});

test('#dockerfileParse refuses a JSON array that holds a value that is not a string', () => {
  expect(() => dockerfileParse('FROM a:1\nCOPY ["x", 1]')).toThrowWithMessage(
    DockerfileError,
    'the JSON array ["x", 1] holds a value that is not a string',
  );
});

test('#dockerfileParse reads a JSON-looking array that does not parse as the shell form', () => {
  expect(dockerfileParse('FROM a:1\nCOPY [x y]').instructions[1]).toStrictEqual({
    keyword: 'copy',
    command: 'COPY',
    flags: [],
    rawFlags: '',
    args: '[x y]',
    words: ['[x', 'y]'],
    isJson: false,
    trigger: null,
    line: 2,
    endLine: 2,
  });
});
