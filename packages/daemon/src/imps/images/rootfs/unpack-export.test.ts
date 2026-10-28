import { expect, test } from 'bun:test';
import { assertUnpacked, readSetfcapWarning } from './unpack-export';

// GNU tar 1.35 exits 0 when it runs without CAP_SETFCAP, and prints this
test('#assertUnpacked fails an unpack whose capability tar had no permission to set and names SETFCAP', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: some/file: time stamp in the future\ntar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted\n",
    });
  }).toThrow(
    expect.objectContaining({
      code: 'PRECONDITION_FAILED',
      message:
        "the image has a file capability that impd could not keep (tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted); imp-host needs CAP_SETFCAP (docs/architecture/host.md#privileges)",
    }),
  );
});

test.each([
  [
    "tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Invalid argument",
  ],
  [
    "tar: setxattrat: Cannot set 'user.mime_type' extended attribute for file 'srv/a': Operation not supported",
  ],
])(
  '#assertUnpacked fails an unpack with the line of another attribute tar could not set: %s',
  (line) => {
    expect(() => {
      assertUnpacked({ exitCode: 0, stdout: '', stderr: `${line}\n` });
    }).toThrow(
      expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        message: `the image has an extended attribute that impd could not keep: ${line}`,
      }),
    );
  },
);

test('#assertUnpacked blames SETFCAP when its line comes after another attribute failure', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/a': Operation not supported\ntar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted\n",
    });
  }).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
});

test('#assertUnpacked passes a warning that only names a file called security.capability', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr: 'tar: srv/security.capability: time stamp 2030-01-01 is in the future\n',
    });
  }).not.toThrow();
});

test('#assertUnpacked reads the attribute name, not the file name, of a failed attribute', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/security.capability': Operation not permitted\n",
    });
  }).toThrow(expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR' }));
});

test('#assertUnpacked passes an unpack with no warning', () => {
  expect(() => {
    assertUnpacked({ exitCode: 0, stdout: '', stderr: '' });
  }).not.toThrow();
});

test('#assertUnpacked fails an unpack whose tar exited non-zero with its stderr', () => {
  expect(() => {
    assertUnpacked({ exitCode: 2, stdout: '', stderr: 'tar: Unexpected EOF in archive' });
  }).toThrowWithMessage(Error, 'tar exited 2: tar: Unexpected EOF in archive');
});

// The mask is imp-host's capability set from deploy/imp-host.args.json, which holds bit 31.
test('#readSetfcapWarning gives no start warning when CapEff holds CAP_SETFCAP', () => {
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000882814fb\n')).toBeNull();
});

test('#readSetfcapWarning gives the start warning when CapEff lacks CAP_SETFCAP', () => {
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000082814fb\n')).toBe(
    'no CAP_SETFCAP, so an image add or build fails on an image with a file capability; imp-host needs CAP_SETFCAP (docs/architecture/host.md#privileges)',
  );
});
