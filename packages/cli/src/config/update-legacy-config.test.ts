import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeUpdateReadOnly } from '@impz/test-utils/probe-update-read-only';
import { updateReadOnly } from '@impz/test-utils/update-read-only';
import { updateLegacyConfig } from './update-legacy-config';

// `stack` makes a read-only tree writable again before the directory goes
function setupTest() {
  const stack = new DisposableStack();

  onTestFinished(() => {
    stack.dispose();
  });

  const directory = mkdtempSync(join(tmpdir(), 'impz-legacy-'));

  stack.defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory, stack };
}

test('it moves the saved hosts and the token file from the old directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
  writeFileSync(join(ctx.directoryPath, 'imp', 'token'), 'file-token\n');

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn);

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'token'), 'utf8')).toBe('file-token\n');
  expect(existsSync(join(ctx.directoryPath, 'imp'))).toBeFalse();
  expect(statSync(join(ctx.directoryPath, 'impz')).mode & 0o777).toBe(0o700);

  expect(warn.mock.calls).toStrictEqual([
    [
      `impz: moved ${join(ctx.directoryPath, 'imp', 'config.json')} to ${join(ctx.directoryPath, 'impz', 'config.json')}`,
    ],
    [
      `impz: moved ${join(ctx.directoryPath, 'imp', 'token')} to ${join(ctx.directoryPath, 'impz', 'token')}`,
    ],
  ]);
});

test('it never looks up the old path when impz has both files', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'impz'));
  writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');
  writeFileSync(join(ctx.directoryPath, 'impz', 'token'), 'file-token\n');

  // a link to itself, so any lookup under the old path fails with ELOOP
  symlinkSync('imp', join(ctx.directoryPath, 'imp'));

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn);

  expect(warn).not.toHaveBeenCalled();
});

test('it notes an old path it cannot look up and leaves the config impz has', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'impz'));
  writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');

  // a link to itself, so any lookup under the old path fails with ELOOP
  symlinkSync('imp', join(ctx.directoryPath, 'imp'));

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn);

  const prefix = `impz: cannot look for ${join(ctx.directoryPath, 'imp', 'token')} to move it: `;

  expect(warn.mock.calls).toStrictEqual([
    [expect.toSatisfy((line: string) => line.startsWith(prefix) && line.includes('ELOOP'))],
  ]);

  expect(readdirSync(join(ctx.directoryPath, 'impz'))).toStrictEqual(['config.json']);
});

test('it reads an old path that is a file as holding no config', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'imp'), 'another tool\n');

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn);

  expect(warn).not.toHaveBeenCalled();
  expect(readdirSync(ctx.directoryPath)).toStrictEqual(['imp']);
});

test('it never moves over a file impz has already', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'config.json'), 'old\n');
  mkdirSync(join(ctx.directoryPath, 'impz'));
  writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), 'new\n');

  const warn = mock<(line: string) => void>();

  updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn);

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'config.json'), 'utf8')).toBe('new\n');
  expect(readFileSync(join(ctx.directoryPath, 'imp', 'config.json'), 'utf8')).toBe('old\n');
  expect(warn).not.toHaveBeenCalled();
});

test.skipIf(!probeUpdateReadOnly())(
  'it finishes a move that failed after it made the directory, once the old one is writable again',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.directoryPath, 'imp'));
    writeFileSync(join(ctx.directoryPath, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
    writeFileSync(join(ctx.directoryPath, 'imp', 'token'), 'file-token\n');

    const restore = updateReadOnly(ctx.stack, join(ctx.directoryPath, 'imp'));

    const failure: unknown = (() => {
      try {
        updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());
      } catch (error) {
        return error;
      }

      return null;
    })();

    const leftBehind = readdirSync(join(ctx.directoryPath, 'impz'));

    restore();

    const warn = mock<(line: string) => void>();

    updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn);

    expect(failure).toMatchObject({ code: expect.toBeOneOf(['EACCES', 'EPERM']) });
    expect(leftBehind).toStrictEqual([]);

    expect(readFileSync(join(ctx.directoryPath, 'impz', 'config.json'), 'utf8')).toBe(
      '{"current":null,"hosts":{}}\n',
    );

    expect(readFileSync(join(ctx.directoryPath, 'impz', 'token'), 'utf8')).toBe('file-token\n');
    expect(existsSync(join(ctx.directoryPath, 'imp'))).toBeFalse();

    expect(warn.mock.calls).toStrictEqual([
      [
        `impz: moved ${join(ctx.directoryPath, 'imp', 'config.json')} to ${join(ctx.directoryPath, 'impz', 'config.json')}`,
      ],
      [
        `impz: moved ${join(ctx.directoryPath, 'imp', 'token')} to ${join(ctx.directoryPath, 'impz', 'token')}`,
      ],
    ]);
  },
);

test('it moves the file a part-way move left behind, beside the one it moved', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'token'), 'file-token\n');
  mkdirSync(join(ctx.directoryPath, 'impz'));
  writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readdirSync(join(ctx.directoryPath, 'impz')).toSorted()).toStrictEqual([
    'config.json',
    'token',
  ]);

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'token'), 'utf8')).toBe('file-token\n');
});

test.skipIf(!probeUpdateReadOnly())(
  'it notes a file the caller does not read that cannot move, and leaves it',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.directoryPath, 'impz'));
    writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');
    mkdirSync(join(ctx.directoryPath, 'imp'));
    writeFileSync(join(ctx.directoryPath, 'imp', 'token'), 'file-token\n');
    updateReadOnly(ctx.stack, join(ctx.directoryPath, 'imp'));

    const warn = mock<(line: string) => void>();

    updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn, ['config.json']);

    const note = `impz: cannot move ${join(ctx.directoryPath, 'imp', 'token')} to ${join(ctx.directoryPath, 'impz', 'token')}, so it stays there: `;

    expect(warn.mock.calls).toStrictEqual([
      [expect.toSatisfy((line: string) => line.startsWith(note) && /EACCES|EPERM/u.test(line))],
    ]);

    expect(readFileSync(join(ctx.directoryPath, 'imp', 'token'), 'utf8')).toBe('file-token\n');
    expect(readdirSync(join(ctx.directoryPath, 'impz'))).toStrictEqual(['config.json']);
  },
);

test.skipIf(!probeUpdateReadOnly())(
  'it takes back the link it made when the old symlink cannot go, so a later call moves it',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.directoryPath, 'impz'));
    writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');
    mkdirSync(join(ctx.directoryPath, 'imp'));
    writeFileSync(join(ctx.directoryPath, 'token-source'), 'file-token\n');
    symlinkSync(join(ctx.directoryPath, 'token-source'), join(ctx.directoryPath, 'imp', 'token'));

    const restore = updateReadOnly(ctx.stack, join(ctx.directoryPath, 'imp'));

    updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>(), [
      'config.json',
    ]);

    const afterFailure = readdirSync(join(ctx.directoryPath, 'impz'));

    restore();

    const warn = mock<(line: string) => void>();

    updateLegacyConfig(join(ctx.directoryPath, 'impz'), warn, ['config.json']);

    expect(afterFailure).toStrictEqual(['config.json']);

    expect(readlinkSync(join(ctx.directoryPath, 'impz', 'token'))).toBe(
      join(ctx.directoryPath, 'token-source'),
    );

    expect(existsSync(join(ctx.directoryPath, 'imp'))).toBeFalse();

    expect(warn.mock.calls).toStrictEqual([
      [
        `impz: moved ${join(ctx.directoryPath, 'imp', 'token')} to ${join(ctx.directoryPath, 'impz', 'token')}`,
      ],
    ]);
  },
);

test.skipIf(!probeUpdateReadOnly())(
  'it rethrows the failed move of a file the caller reads',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.directoryPath, 'impz'));
    writeFileSync(join(ctx.directoryPath, 'impz', 'config.json'), '{"current":null,"hosts":{}}\n');
    mkdirSync(join(ctx.directoryPath, 'imp'));
    writeFileSync(join(ctx.directoryPath, 'imp', 'token'), 'file-token\n');
    updateReadOnly(ctx.stack, join(ctx.directoryPath, 'imp'));

    expect(() => {
      updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());
    }).toThrow(expect.objectContaining({ code: expect.toBeOneOf(['EACCES', 'EPERM']) }));
  },
);

test('it makes no directory when the old one holds neither file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'notes.txt'), 'another tool\n');
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readdirSync(ctx.directoryPath)).toStrictEqual(['imp']);
});

test('it leaves the old directory with whatever else it holds', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'token'), 'file-token\n');
  writeFileSync(join(ctx.directoryPath, 'imp', 'notes.txt'), 'kept\n');
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readdirSync(join(ctx.directoryPath, 'imp'))).toStrictEqual(['notes.txt']);
  expect(readFileSync(join(ctx.directoryPath, 'impz', 'token'), 'utf8')).toBe('file-token\n');
});

test('it moves a relative symlink that still resolves after the move', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'dotfiles'));

  writeFileSync(
    join(ctx.directoryPath, 'dotfiles', 'config.json'),
    '{"current":null,"hosts":{}}\n',
  );

  mkdirSync(join(ctx.directoryPath, 'imp'));
  symlinkSync('../dotfiles/config.json', join(ctx.directoryPath, 'imp', 'config.json'));
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.directoryPath, 'impz', 'config.json'))).toBe(
    '../dotfiles/config.json',
  );

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it points a moved symlink at a file that stays in the old directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'hosts.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('hosts.json', join(ctx.directoryPath, 'imp', 'config.json'));
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.directoryPath, 'impz', 'config.json'))).toBe('../imp/hosts.json');

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it points a moved symlink at the other moved file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'imp'));
  writeFileSync(join(ctx.directoryPath, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('./config.json', join(ctx.directoryPath, 'imp', 'token'));
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.directoryPath, 'impz', 'token'))).toBe('config.json');

  expect(readFileSync(join(ctx.directoryPath, 'impz', 'token'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it keeps an absolute symlink as it was', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'root-token'), 'root\n');
  mkdirSync(join(ctx.directoryPath, 'imp'));
  symlinkSync(join(ctx.directoryPath, 'root-token'), join(ctx.directoryPath, 'imp', 'token'));
  updateLegacyConfig(join(ctx.directoryPath, 'impz'), mock<(line: string) => void>());

  expect(readlinkSync(join(ctx.directoryPath, 'impz', 'token'))).toBe(
    join(ctx.directoryPath, 'root-token'),
  );
});

test('it points a moved relative symlink at its file when the old directory is itself a symlink', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'dotfiles', 'imp'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'dotfiles', 'hosts.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('../hosts.json', join(ctx.directoryPath, 'dotfiles', 'imp', 'config.json'));
  mkdirSync(join(ctx.directoryPath, 'config'));
  symlinkSync('../dotfiles/imp', join(ctx.directoryPath, 'config', 'imp'));
  updateLegacyConfig(join(ctx.directoryPath, 'config', 'impz'), mock<(line: string) => void>());

  expect(readFileSync(join(ctx.directoryPath, 'config', 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});
